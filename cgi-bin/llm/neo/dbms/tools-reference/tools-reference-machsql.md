# machsql Interactive SQL Tool

machsql is an interactive tool that performs SQL queries through the terminal screen.

## Run Option Description

```
[mach@localhost]$ machsql -h
```

| Short Option | Full Option | Description |
|--|--|--|
| -s | --server | Connecting server IP address (default: 127.0.0.1) |
| -u | --user | User name (default: SYS) |
| -p | --password | User password (default: MANAGER) |
| -P | --port | Server port number (default: 5656) |
| -n | --nls | NLS configuration |
| -f | --script | SQL script file to run |
| -z | --timezone=+-HHMM | Set Timezone ex) +0900   -1230 |
| -o | --output | Filename to save query results |
| -i | --silent | Runs without the copyright notice |
| -v | --verbose | Detailed output |
| -r | --format | Specifies output file format (default: csv) |
| -h | --help | Displays options |
| -c | N/A | Add Connection parameter (Supported from version 6.1 or later) |

### Examples

```
machsql -s localhost -u sys -p manager
machsql --server=localhost --user=sys --password=manager
machsql -s localhost -u sys -p manager -f script.sql
machsql -s 127.0.0.1 -u sys -p manager -P 8888 -c ALTERNATIVE_SERVERS=192.168.0.147:9209;CONNECTION_TIMEOUT=10
```

## Environment Variable MACHBASE_CONNECTION_STRING

Specifies basic connection parameters. For example, to add CONNECTION_TIMEOUT, ALTERNATIVE_SERVERS:

```
export MACHBASE_CONNECTION_STRING=ALTERNATIVE_SERVERS=192.168.0.148:8888;CONNECTION_TIMEOUT=3
```

Setting connection parameter with -c option takes precedence over environment variables. This option is supported from version 6.1 or later.

## Using HEREDOC for SQL Scripts

machsql supports HEREDOC (Here Document) syntax, allowing you to pass SQL commands directly from the shell without creating a separate file.

> **Note**: This feature is supported from Machbase version 8.0.50 or later.

### Basic Syntax

```bash
machsql -s <server> -u <user> -p <password> <<'DELIMITER'
SQL statements here
DELIMITER
```

### Examples

**Simple query execution:**

```bash
machsql -s 127.0.0.1 -u sys -p manager <<'SQLBLOCK'
select 'WORKS!!!!' from v$tables limit 2;
SQLBLOCK
```

**Multiple statements:**

```bash
machsql -s 127.0.0.1 -u sys -p manager <<'EOF'
CREATE TABLE test_table (id INTEGER, name VARCHAR(100));
INSERT INTO test_table VALUES (1, 'First Record');
INSERT INTO test_table VALUES (2, 'Second Record');
SELECT * FROM test_table;
DROP TABLE test_table;
EOF
```

**Using variables (without quotes on delimiter):**

```bash
TABLE_NAME="my_table"
machsql -s 127.0.0.1 -u sys -p manager <<EOF
SELECT COUNT(*) FROM ${TABLE_NAME};
EOF
```

**With output redirection:**

```bash
machsql -s 127.0.0.1 -u sys -p manager <<'SQL' > output.csv
SELECT name, time, value FROM tag_table
WHERE time >= NOW - INTERVAL 1 HOUR
ORDER BY time DESC;
SQL
```

## SHOW Command

Displays information such as tables, tablespaces, and indexes.

SHOW command list:

* SHOW INDEX
* SHOW INDEXES
* SHOW INDEXGAP
* SHOW LSM
* SHOW LICENSE
* SHOW STATEMENTS
* SHOW STORAGE
* SHOW TABLE
* SHOW TABLES
* SHOW TABLESPACE
* SHOW TABLESPACES
* SHOW USERS

### SHOW INDEX

Displays index information.

```
SHOW INDEX index_name
```

### SHOW INDEXES

Displays entire index list.

```
SHOW INDEXES
```

### SHOW INDEXGAP

Displays index building GAP information.

```
SHOW INDEXGAP
```

### SHOW LSM

Displays LSM index building information.

```
SHOW LSM
```

### SHOW LICENSE

Displays license information.

```
SHOW LICENSE
```

### SHOW STATEMENTS

Displays all query statements (Prepare, Execute, Fetch) registered in the server.

```
SHOW STATEMENTS
```

### SHOW STORAGE

Displays the disk usage for each table created by the user.

```
SHOW STORAGE
```

### SHOW TABLE

Displays information about the table created by the user.

```
SHOW TABLE table_name
```

### SHOW TABLES

Displays a list of all tables created by the user.

```
SHOW TABLES
```

### SHOW TABLESPACE / SHOW TABLESPACES

Displays tablespace information.

```
SHOW TABLESPACE tablespace_name
SHOW TABLESPACES
```

### SHOW USERS

Displays a list of users.

```
SHOW USERS
```
