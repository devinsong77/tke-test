import importlib.util
import io
import json
import pytest
from pathlib import Path

spec = importlib.util.spec_from_file_location('gate_client', Path(__file__).parents[1] / 'scripts/gate_client.py')
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


@pytest.mark.parametrize('state,expected', [('PASS',0),('BLOCK',2),('ERROR',3)])
def test_client_exits_and_publishes_output_only_on_pass(monkeypatch,tmp_path,capsys,state,expected):
    for key,value in {'GATE_URL':'https://gate.invalid','GATE_TOKEN':'test-token','GATE_HMAC_KEY':'test-key',
                      'BUILD_SOURCEVERSION':'a'*40,'BUILD_BUILDID':'42','ADO_RUN_URL':'https://dev.azure.com/test/p/run',
                      'GATE_EVIDENCE_DIR':str(tmp_path)}.items():
        monkeypatch.setenv(key,value)
    replies=iter([{'review_id':'review123','status':'queued'},
                  {'review_id':'review123','status':state,'request':{'commit_sha':'a'*40, 'repository':'tke-test', 'policy_version':'policy-v1', 'ado_run_id':'42', 'ado_run_url':'https://dev.azure.com/test/p/run', 'ref':'refs/heads/main'},
                   'result':{'status':state,'commit_sha':'a'*40,'policy_version':'policy-v1'}}])
    monkeypatch.setattr(client.urllib.request,'urlopen',lambda *a,**k:io.BytesIO(json.dumps(next(replies)).encode()))
    assert client.main()==expected
    output=capsys.readouterr().out
    assert ('##vso[task.setvariable' in output)==(state=='PASS')
    assert (tmp_path/'review.json').exists()


def test_client_rejects_wrong_commit(monkeypatch):
    for key,value in {'GATE_URL':'https://gate.invalid','GATE_TOKEN':'token','GATE_HMAC_KEY':'key',
                      'BUILD_SOURCEVERSION':'a'*40,'BUILD_BUILDID':'42','ADO_RUN_URL':'https://dev.azure.com/test/p/run'}.items():
        monkeypatch.setenv(key,value)
    replies=iter([{'review_id':'review123'}, {'review_id':'review123','status':'PASS','request':{'commit_sha':'b'*40}}])
    monkeypatch.setattr(client.urllib.request,'urlopen',lambda *a,**k:io.BytesIO(json.dumps(next(replies)).encode()))
    with pytest.raises(RuntimeError,match='identity mismatch'):
        client.main()
