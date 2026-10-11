-- Persist the owned accepted personal avatar independently of the seven stock-look fields.
-- Up Migration
ALTER TABLE characters ADD COLUMN likeness_job_id uuid REFERENCES likeness_jobs(id) ON DELETE RESTRICT;
-- Down Migration
ALTER TABLE characters DROP COLUMN likeness_job_id;
