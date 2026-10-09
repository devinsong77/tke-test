"""Run fixed scanner images against an immutable checkout; never execute repository scripts."""
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path

import httpx
from app import core

IMAGES = {
    'gitleaks': 'ghcr.io/gitleaks/gitleaks:v8.30.1',
    'trivy': 'aquasec/trivy:0.75.0',
    'checkov': 'bridgecrew/checkov:3.3.26',
    'sonarqube': 'sonarsource/sonar-scanner-cli:12.2.0.4256_8.1.0',
}


def execute(args, timeout=600, env=None, cwd=None):
    result = subprocess.run(args, capture_output=True, timeout=timeout, env=env, cwd=cwd)
    return result.returncode, result.stdout.decode(errors='replace'), result.stderr.decode(errors='replace')


def checked(args, **kwargs):
    code, out, err = execute(args, **kwargs)
    if code:
        raise RuntimeError(f'{args[0]} failed (exit {code})')
    return out


def docker(tool, source, rid, args, *, network='none', extra=None, timeout=600, env=None):
    name = f'tke-scan-{rid}-{tool}'
    cmd = ['docker', 'run', '--rm', '--name', name, '--label', 'tke.scanner=true',
           '--network', network, '--cap-drop=ALL', '--security-opt=no-new-privileges',
           '--user', f'{os.getuid()}:{os.getgid()}', ('--memory=4g' if tool == 'sonarqube' else '--memory=2g'), '--cpus=2', '--pids-limit=256', '--read-only',
           '--tmpfs', (f'/scan-work:rw,nosuid,nodev,exec,size=1g,mode=0700,uid={os.getuid()},gid={os.getgid()}' if tool == 'sonarqube' else f'/scan-work:rw,nosuid,nodev,noexec,size=1g,mode=0700,uid={os.getuid()},gid={os.getgid()}'), '-v', f'{source}:/src:ro', '-w', '/scan-work', '-e', 'HOME=/scan-work', '-e', 'TMPDIR=/scan-work']
    if extra:
        cmd += extra
    cmd += [IMAGES[tool]] + args
    try:
        result = execute(cmd, timeout=timeout, env=env)
        diagnostics = {'exit_code': result[0], 'stdout_tail': result[1][-12000:], 'stderr_tail': result[2][-12000:]}
        for secret in [v for k,v in (env or {}).items() if k in ('SONAR_TOKEN',)]:
            diagnostics = {k: (v.replace(secret, '[REDACTED]') if isinstance(v, str) else v) for k,v in diagnostics.items()}
        # Local operational log only, never exposed by the artifact API.
        if result[0] not in (0, 10):
            core.atomic_json(core.DATA / 'diagnostics' / f'{rid}-{tool}.json', diagnostics)
        return result
    finally:
        execute(['docker', 'rm', '-f', name], timeout=30)


def finding(tool, rule, severity, title, file='', line=0, description='', remediation='Review and remediate the reported issue.'):
    severity = severity.upper()
    if severity not in {'CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'}:
        severity = 'INFO'
    value = {'tool': tool, 'rule': rule, 'severity': severity, 'title': title,
             'file': file.removeprefix('/src/'), 'line': line or 0,
             'description': description, 'remediation': remediation}
    value['fingerprint'] = core.digest({k: value[k] for k in ('tool', 'rule', 'file', 'line', 'title')})
    return value


def scan_gitleaks(src, dest, rid, request, policy):
    # Server policy only: exact literal placeholders, never repository-supplied exclusions.
    config = dest / 'gitleaks-policy.toml'
    patterns = [f'^{re.escape(value)}$' for value in policy.get('gitleaks_known_placeholders', [])]
    text = '[extend]\nuseDefault = true\n'
    if patterns:
        text += '\n[allowlist]\ndescription = "Reviewed non-secret template literals"\nregexTarget = "secret"\nregexes = [' + ', '.join("'''" + value + "'''" for value in patterns) + ']\n'
    config.write_text(text)
    combined = []
    exits = []
    for mode in ('git', 'dir'):
        code, out, _ = docker('gitleaks', src, rid,
            [mode, '/src', *(['--log-opts=' + request['commit_sha']] if mode == 'git' else []), '--redact=100', '--ignore-gitleaks-allow', '--report-format=json',
             '--report-path=/dev/stdout', '--exit-code=10', '--no-banner', '--config=/policy.toml'],
            extra=['-v', f'{config}:/policy.toml:ro'])
        if code not in (0, 10):
            raise RuntimeError(f'Gitleaks {mode} failed (exit {code})')
        report = json.loads(out)
        if not isinstance(report, list):
            raise ValueError('Gitleaks report must be an array')
        for item in report:
            # Do not retain source snippets or secret values, even if a tool redaction regresses.
            combined.append({k: item.get(k) for k in ('RuleID', 'Description', 'File', 'StartLine', 'EndLine', 'Commit', 'Fingerprint')})
        exits.append(code)
    core.atomic_json(dest / 'gitleaks.json', combined)
    items = [finding('gitleaks', x['RuleID'], 'HIGH', x['Description'], x['File'], x['StartLine'],
                     remediation='Revoke any real credential, remove it from code/history, and use a secret store.')
             | {'commit_sha': x.get('Commit') or request['commit_sha']} for x in combined]
    items = list({x['fingerprint']: x for x in items}.values())
    return {'exit_code': exits, 'scope': ['working tree', 'complete history reachable from requested commit']}, items


def scan_checkov(src, dest, rid, request, policy):
    code, out, _ = docker('checkov', src, rid,
        ['--directory', '/src', '--framework', 'dockerfile', 'terraform', 'kubernetes', 'github_actions',
         '--output', 'json', '--skip-download', '--download-external-modules', 'false'])
    if code not in (0, 1):
        raise RuntimeError(f'Checkov failed (exit {code})')
    report = json.loads(out)
    reports = report if isinstance(report, list) else [report]
    if not reports or any(not isinstance(r.get('results'), dict) for r in reports):
        raise ValueError('Checkov report missing results')
    findings = []
    checked_files = set()
    count = 0
    for part in reports:
        results = part['results']
        if results.get('parsing_errors'):
            raise ValueError('Checkov could not parse input')
        for item in results.get('passed_checks', []) + results.get('failed_checks', []) + results.get('skipped_checks', []):
            checked_files.add(item['file_path'].lstrip('/'))
            count += 1
            item.pop('code_block', None)
        for item in results.get('failed_checks', []) + results.get('skipped_checks', []):
            findings.append(finding('checkov', item['check_id'], item.get('severity') or policy['checkov_unrated_severity'],
                item['check_name'], item['file_path'].lstrip('/'), (item.get('file_line_range') or [0])[0],
                description='Repository-local suppressions are not approved exceptions.',
                remediation=item.get('guideline') or 'Remediate the configuration according to the rule.'))
    if count == 0:
        raise ValueError('Checkov scanned zero supported resources')
    core.atomic_json(dest / 'checkov.json', reports)
    return {'exit_code': code, 'checked_files': sorted(checked_files), 'checks': count}, findings


def scan_trivy(src, dest, rid, request, policy):
    cache = core.DATA / 'trivy-cache'
    cache.mkdir(exist_ok=True)
    code, out, _ = docker('trivy', src, rid,
        ['filesystem', '--scanners', 'vuln', '--format', 'json', '--cache-dir', '/cache',
         '--ignorefile', '/dev/null', '--config', '/dev/null', '--timeout', '8m', '/src'],
        network='bridge', extra=['-v', f'{cache}:/cache:rw'], timeout=600)
    if code:
        raise RuntimeError(f'Trivy failed (exit {code})')
    report = json.loads(out)
    if report.get('SchemaVersion') != 2:
        raise ValueError('Unsupported Trivy report schema')
    metadata = json.loads((cache / 'db' / 'metadata.json').read_text())
    updated = dt.datetime.fromisoformat(metadata['UpdatedAt'].replace('Z', '+00:00'))
    age = (dt.datetime.now(dt.timezone.utc) - updated).total_seconds() / 3600
    if age > policy['trivy_db_max_age_hours'] or age < -1:
        raise ValueError('Trivy vulnerability database outside freshness policy')
    core.atomic_json(dest / 'trivy.json', report)
    findings = []
    targets = []
    for result in report.get('Results', []):
        targets.append(result['Target'])
        for item in result.get('Vulnerabilities') or []:
            findings.append(finding('trivy', item['VulnerabilityID'], item['Severity'],
                item.get('Title') or item['VulnerabilityID'], result['Target'], description=f'{item["PkgName"]} {item["InstalledVersion"]}',
                remediation=f'Upgrade to {item.get("FixedVersion") or "a supported non-vulnerable version"}.'))
    return {'exit_code': code, 'database': metadata, 'targets': targets}, findings


def scan_sonar(src, dest, rid, request, policy):
    settings = core.config('integrations.json')['sonar']
    project = f'tke-{rid}'
    with httpx.Client(base_url=settings['url'], auth=(settings['token'], ''), timeout=30) as client:
        response = client.post('/api/projects/create', data={'project': project, 'name': project, 'visibility': 'private'})
        response.raise_for_status()
        env = dict(os.environ, SONAR_TOKEN=settings['token'])
        code, out, _ = docker('sonarqube', src, rid,
            [f'-Dsonar.host.url={settings["url"]}', f'-Dsonar.projectKey={project}',
             '-Dsonar.python.version=3.12', '-Dsonar.projectBaseDir=/src', '-Dsonar.sources=.', '-Dsonar.working.directory=/scan-work/analysis',
             '-Dsonar.scanner.metadataFilePath=/scan-work/report-task.txt',
             f'-Dsonar.scm.revision={request["commit_sha"]}', '-Dsonar.scm.exclusions.disabled=true',
             '-Dsonar.exclusions=**/.git/**', '-Dsonar.javascript.node.maxspace=512', '-Dsonar.qualitygate.wait=true', '-Dsonar.qualitygate.timeout=300'],
            network='host', extra=['-e', 'SONAR_TOKEN', '-e', 'SONAR_USER_HOME=/scan-work/sonar', '-e', 'SONAR_SCANNER_JAVA_OPTS=-Xmx512m'], env=env)
        # CLI returns nonzero for a failed Quality Gate; CE status and bound analysis remain authoritative.
        tasks = client.get('/api/ce/component', params={'component': project})
        tasks.raise_for_status()
        task = tasks.json().get('current', {})
        if task.get('status') != 'SUCCESS' or not task.get('analysisId'):
            raise RuntimeError(f'Sonar analysis incomplete (scanner exit {code})')
        analysis_id = task['analysisId']
        analyses = client.get('/api/project_analyses/search', params={'project': project}).json().get('analyses', [])
        analysis = next((a for a in analyses if a['key'] == analysis_id), None)
        if not analysis or analysis.get('revision') != request['commit_sha']:
            raise ValueError('Sonar analysis commit does not match requested commit')
        qg = client.get('/api/qualitygates/project_status', params={'analysisId': analysis_id})
        qg.raise_for_status()
        quality = qg.json()['projectStatus']
        actual_conditions = {x['metricKey']: x.get('errorThreshold') for x in quality.get('conditions', [])}
        if actual_conditions != policy['sonar_quality_gate']['conditions']:
            raise ValueError('Sonar Quality Gate conditions differ from bound policy')
        issues = []
        page = 1
        while True:
            response = client.get('/api/issues/search', params={'componentKeys': project, 'ps': 500, 'p': page})
            response.raise_for_status()
            data = response.json()
            issues.extend(data['issues'])
            if len(issues) >= data['paging']['total']:
                break
            page += 1
        files = []
        page = 1
        while True:
            response = client.get('/api/components/tree', params={'component': project, 'qualifiers': 'FIL', 'ps': 500, 'p': page})
            response.raise_for_status()
            page_data = response.json()
            files.extend(x['path'] for x in page_data['components'])
            if len(files) >= page_data['paging']['total']:
                break
            page += 1
        core.atomic_json(dest / 'sonarqube.json', {'analysis': analysis, 'task': task, 'quality_gate': quality, 'issues': issues, 'analyzed_files': files})
        severity = {'BLOCKER': 'CRITICAL', 'CRITICAL': 'HIGH', 'MAJOR': 'MEDIUM', 'MINOR': 'LOW', 'INFO': 'INFO'}
        findings = [finding('sonarqube', x['rule'], severity.get(x.get('severity'), 'MEDIUM'), x['message'],
                            x.get('component', '').removeprefix(project + ':'), x.get('line', 0),
                            remediation='Review the Sonar rule and resolve the issue.') | {'category': x.get('type', 'VULNERABILITY'), 'original_severity': x.get('severity')} for x in issues]
        return {'exit_code': code, 'analysis_id': analysis_id, 'quality_gate': quality['status'],
                'project_key': project, 'revision': analysis['revision'], 'analyzed_files': files}, findings


def inventory(source):
    paths = checked(['git', '-C', str(source), 'ls-files', '-z']).split('\x00')
    records = []
    for name in filter(None, paths):
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Symlinks/submodules are outside approved pilot scope: {name}')
        tools = ['gitleaks']
        kind = 'supporting file'
        not_applicable = {}
        if path.suffix in ('.py', '.js', '.ts', '.java', '.go') and path.stat().st_size:
            tools.append('sonarqube')
            kind = 'source'
        if path.name.startswith('Dockerfile') or path.suffix == '.tf' or 'k8s/' in name or name.startswith('.github/workflows/'):
            tools.append('checkov')
            kind = 'configuration'
        if path.name in ('requirements.txt', 'package-lock.json', 'poetry.lock', 'go.sum', 'Pipfile.lock'):
            if path.name == 'requirements.txt' and not any(line.strip() and not line.lstrip().startswith('#') for line in path.read_text().splitlines()):
                not_applicable['trivy'] = 'Requirements file contains no dependency declarations'
            else:
                tools.append('trivy')
            kind = 'dependencies'
        if path.suffix == '.sh':
            checked(['bash', '-n', str(path)], timeout=10)
            kind = 'shell script: syntax checked; secret scan; no supported Sonar SAST analyzer'
        records.append({'path': name, 'kind': kind, 'required_tools': tools, 'status': 'pending',
                        'not_applicable': not_applicable,
                        'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    if not records:
        raise ValueError('Empty source tree')
    return records


def run_scanner(tool, src, dest, rid, request, policy):
    started = time.time()
    scan = {'status': 'failed', 'commit_sha': request['commit_sha'], 'image': IMAGES[tool], 'started_at': started}
    findings = []
    try:
        image = json.loads(checked(['docker', 'image', 'inspect', IMAGES[tool]]))[0]
        scan['image_id'] = image['Id']
        scan['image_digests'] = image.get('RepoDigests', [])
        extra, findings = {'gitleaks': scan_gitleaks, 'checkov': scan_checkov, 'trivy': scan_trivy,
                           'sonarqube': scan_sonar}[tool](src, dest, rid, request, policy)
        scan.update(extra, status='success')
    except Exception as error:
        scan['error'] = f'{type(error).__name__}: {error}'[:500]
    scan['duration_seconds'] = round(time.time() - started, 3)
    core.atomic_json(dest / f'{tool}-metadata.json', scan)
    core.audit(rid, f'scan.{tool}.{scan["status"]}', scan)
    return scan, findings
