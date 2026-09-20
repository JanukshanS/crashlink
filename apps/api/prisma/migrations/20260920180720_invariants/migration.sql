-- One open rental per bike and per driver (FR-RENT-02)
CREATE UNIQUE INDEX rentals_one_open_per_bike
  ON rentals (bike_id) WHERE state IN ('PENDING_SYNC','ACTIVE','ENDING_SYNC');
CREATE UNIQUE INDEX rentals_one_open_per_driver
  ON rentals (driver_id) WHERE state IN ('PENDING_SYNC','ACTIVE','ENDING_SYNC');

-- One current emergency contact per driver
CREATE UNIQUE INDEX emergency_contacts_one_current
  ON emergency_contacts (driver_id) WHERE is_current = true;

-- Coordinate sanity
ALTER TABLE location_samples ADD CONSTRAINT chk_lat CHECK (lat BETWEEN -90 AND 90);
ALTER TABLE location_samples ADD CONSTRAINT chk_lon CHECK (lon BETWEEN -180 AND 180);

-- Decision consistency
ALTER TABLE incidents ADD CONSTRAINT chk_deadline
  CHECK (response_deadline_at IS NULL OR question_sent_at IS NOT NULL);

-- Fast deadline worker scan
CREATE INDEX incidents_pending_deadline
  ON incidents (response_deadline_at) WHERE decision = 'PENDING';
