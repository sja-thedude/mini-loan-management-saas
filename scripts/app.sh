#!/usr/bin/env bash
# Start/stop the AWS deployment on demand (compute is billed only while running).
# Usage: AWS_PROFILE=loan scripts/app.sh start|stop|status|url|logs
set -euo pipefail
CLUSTER=loan-app SERVICE=loan-app
url() {
  local task eni ip
  task=$(aws ecs list-tasks --cluster $CLUSTER --service-name $SERVICE --desired-status RUNNING --query 'taskArns[0]' --output text)
  [ "$task" = "None" ] && { echo "not running"; return; }
  eni=$(aws ecs describe-tasks --cluster $CLUSTER --tasks "$task" --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value" --output text)
  ip=$(aws ec2 describe-network-interfaces --network-interface-ids "$eni" --query 'NetworkInterfaces[0].Association.PublicIp' --output text)
  echo "http://$ip:3001"
}
case "${1:-status}" in
  start)
    aws ecs update-service --cluster $CLUSTER --service $SERVICE --desired-count 1 --query 'service.desiredCount' >/dev/null
    echo "starting (Aurora resumes from zero on first connection)..."
    aws ecs wait services-stable --cluster $CLUSTER --services $SERVICE
    url ;;
  stop)
    aws ecs update-service --cluster $CLUSTER --service $SERVICE --desired-count 0 --query 'service.desiredCount' >/dev/null
    echo "stopped: Fargate billing ends; Aurora pauses itself after 5 idle minutes" ;;
  status)
    aws ecs describe-services --cluster $CLUSTER --services $SERVICE --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount}' --output table ;;
  url) url ;;
  logs) aws logs tail /ecs/loan-app --since 15m --follow ;;
  *) echo "usage: $0 start|stop|status|url|logs"; exit 1 ;;
esac
