-- Migration 0001: Initial schema
-- All table creation is handled by initializeDatabase() at runtime
-- This migration exists only to satisfy the migration tracking system
-- The runtime code in src/db/schema.ts creates all tables on first request

SELECT 1;
