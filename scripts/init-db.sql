-- Application role without superuser or BYPASSRLS, so row-level security applies.
CREATE ROLE avix_app LOGIN PASSWORD 'avix_app' NOSUPERUSER NOBYPASSRLS;
GRANT ALL ON DATABASE avixcheck TO avix_app;
ALTER DATABASE avixcheck OWNER TO avix_app;
