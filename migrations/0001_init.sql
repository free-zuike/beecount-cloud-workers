-- Migration 0001: Initial schema
-- Backup tables use INTEGER PRIMARY KEY AUTOINCREMENT for id
-- (frontend expects id as number, D1 TEXT PK gave NULL when not specified)

SELECT 1;
