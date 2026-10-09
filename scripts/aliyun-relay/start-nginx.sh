#!/bin/sh
set -eu
# Reuse the matching-certificate snapshot, validation and graceful reload logic
# from this same source commit; the Aliyun template remains independently owned.
exec /bin/sh /common/start-nginx.sh
