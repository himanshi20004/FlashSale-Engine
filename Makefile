up:          ; docker compose up --build -d mongo redis redis-bus backend frontend prometheus redis-exporter grafana
down:        ; docker compose down -v
load:        ; HOLD_TTL_SEC=20 docker compose up -d backend prometheus && docker compose --profile load run --rm k6
chaos:       ; ./scripts/chaos.sh
verify:      ; ./scripts/verify.sh drop-1
seed:        ; curl -s -X POST 'localhost:8080/admin/items?reset=true' -H 'content-type: application/json' -H 'x-admin-token: admin-secret' -d '{"id":"concert-1","totalSeats":50,"pricePaise":150000}'
test-lua:    ; cd backend && npm install && npm run test:lua
test-metrics:; cd backend && npm run test:metrics
