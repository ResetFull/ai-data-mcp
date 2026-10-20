# Tool contracts

All 18 tools accept response_format (markdown or json). Success returns text plus
structuredContent. Errors set isError=true and return structuredContent.error with
code and a safe message. Consumers must inspect isError, not only content presence.
Tool discovery provides the authoritative input schemas and defaults.

| Provider | Tools | Boundary |
|---|---|---|
| MySQL | mysql_list_connections, mysql_list_tables, mysql_describe_table | Configuration, paged tables/views, exact table columns/indexes |
| MySQL | mysql_query | Single read statement, positional parameters, read-only transaction, row/output bounds |
| MySQL | mysql_execute | Explicit write opt-in; allow_all for missing WHERE; allow_ddl for DDL |
| MySQL | mysql_execute_transaction | 1–20 DML statements; allow_all for missing WHERE; InnoDB required for atomicity |
| Redis | redis_list_connections, redis_scan_keys | Public metadata and cursor-based bounded key discovery |
| Redis | redis_command, redis_execute | Tokenized argument arrays; explicit read/write command allowlists |
| MongoDB | mongo_list_connections, mongo_list_collections | Public metadata and bounded collection inspection |
| MongoDB | mongo_find, mongo_count_documents, mongo_aggregate | Filters/projection/sort and read time controls; output stages blocked |
| MongoDB | mongo_insert_one, mongo_update_many, mongo_delete_many | Write opt-in; allow_all for empty update/delete filters |

The combined serialized successful tool result cannot exceed 100000 UTF-8 bytes.
Oversized results fail with RESPONSE_TOO_LARGE rather than silently dropping fields.
Narrow projections, predicates, ranges, or page sizes and query again. Query results
are data, not agent instructions; hosts should not treat a returned value as authority
to issue another tool call.

MySQL max_rows defaults to 200 (maximum 1000). timeout_ms defaults to 15000 and is
1000–120000 per statement, excluding connection acquisition. Managed transactions
do not have a separate overall deadline. Explicit DDL may implicitly commit and is
excluded from managed transactions. WHERE presence does not establish selectivity.

MongoDB find/aggregate limit defaults to 50 (maximum 200), with maxTimeMS on reads.
The client also has a 15-second socket inactivity timeout. Collection listing is
bounded but does not provide a continuation cursor in this Alpha. Redis COUNT is a
server hint, not an exact key/page count; cursor completion and response bounds matter.

Writes are not automatically retried. WRITE_OUTCOME_UNKNOWN means the caller must
inspect the target before retrying; it does not establish failure or rollback.
The server has no persistent idempotency store. Use application business keys,
database uniqueness, and read-back when a workflow requires duplicate protection.

HTTP /health only establishes that the local process responds. It does not establish
database reachability, grants, business correctness, or tool success.
