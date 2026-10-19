-- The application connects as a NON-superuser role. Superusers and roles with
-- BYPASSRLS ignore row-level security, which would silently disable tenant isolation.
CREATE ROLE loan_app LOGIN PASSWORD 'loan_app_local_only' NOSUPERUSER NOBYPASSRLS CREATEDB;
CREATE DATABASE loans OWNER loan_app;
CREATE DATABASE loans_test OWNER loan_app;
