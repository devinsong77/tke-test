import subprocess
import pytest
from app.scanners import inventory


def test_inventory_rejects_symlinks(tmp_path):
    subprocess.run(['git', 'init', str(tmp_path)], check=True, capture_output=True)
    (tmp_path / 'outside').symlink_to('/etc/passwd')
    subprocess.run(['git', '-C', str(tmp_path), 'add', 'outside'], check=True)
    with pytest.raises(ValueError, match='Symlinks'):
        inventory(tmp_path)


def test_inventory_binds_files_to_hash_and_required_tools(tmp_path):
    subprocess.run(['git', 'init', str(tmp_path)], check=True, capture_output=True)
    (tmp_path / 'Dockerfile').write_text('FROM scratch\n')
    (tmp_path / 'requirements.txt').write_text('idna==3.20\n')
    (tmp_path / 'app.py').write_text('x = 1\n')
    subprocess.run(['git', '-C', str(tmp_path), 'add', '.'], check=True)
    result = {r['path']: r for r in inventory(tmp_path)}
    assert 'checkov' in result['Dockerfile']['required_tools']
    assert 'trivy' in result['requirements.txt']['required_tools']
    assert 'sonarqube' in result['app.py']['required_tools']
    assert all('gitleaks' in r['required_tools'] for r in result.values())
    assert all(len(r['sha256']) == 64 for r in result.values())
