-- Rename the Neon agent role from cc_agent to mc_agent (cc → mc rebranding).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cc_agent') THEN
    ALTER ROLE cc_agent RENAME TO mc_agent;
  END IF;
END
$$;
