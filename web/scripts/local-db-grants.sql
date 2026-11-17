DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'team_b_app') THEN
    CREATE ROLE team_b_app LOGIN PASSWORD 'team_b_app_local';
  END IF;
END
$$;
