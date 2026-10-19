#!/usr/bin/env bash
# Validates every IAM policy this project defines with IAM Access Analyzer (real AWS, free API).
# Usage: AWS_PROFILE=loan scripts/validate-iam-policies.sh
# Exit code 1 if any ERROR / SECURITY_WARNING finding is returned.
set -euo pipefail
cd "$(dirname "$0")/../infra/local"
tmp=$(mktemp -d)
fail=0
for name in api worker; do
  terraform output -raw "${name}_policy_json" > "$tmp/$name.json"
  findings=$(AWS_ENDPOINT_URL= aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY \
    --policy-document "file://$tmp/$name.json" --output json --query 'findings')
  count=$(echo "$findings" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
  blocking=$(echo "$findings" | python3 -c 'import json,sys; print(sum(f["findingType"] in ("ERROR","SECURITY_WARNING") for f in json.load(sys.stdin)))')
  echo "policy=$name findings=$count blocking=$blocking"
  [ "$count" -gt 0 ] && echo "$findings" | python3 -c 'import json,sys; [print("  -", f["findingType"], f["issueCode"], "-", f["findingDetails"]) for f in json.load(sys.stdin)]'
  [ "$blocking" -gt 0 ] && fail=1
done
# A deliberately bad policy, to show what the analyzer catches.
echo '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*","iam:PassRole"],"Resource":"*"}]}' > "$tmp/bad.json"
echo "policy=intentionally-bad-example (should produce findings):"
AWS_ENDPOINT_URL= aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY --policy-document "file://$tmp/bad.json" \
  --output json --query 'findings[].[findingType,issueCode]' | python3 -c 'import json,sys; [print("  -", t, c) for t, c in json.load(sys.stdin)]'
rm -rf "$tmp"
exit $fail
