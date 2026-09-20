-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'DRIVER', 'ADMIN', 'GUEST');

-- CreateEnum
CREATE TYPE "IgnitionState" AS ENUM ('ON', 'OFF', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "BikeStatus" AS ENUM ('AVAILABLE', 'RENTED', 'MAINTENANCE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "RentalState" AS ENUM ('PENDING_SYNC', 'ACTIVE', 'ENDING_SYNC', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IncidentType" AS ENUM ('POSSIBLE_COLLISION', 'POSSIBLE_LOW_SPEED_RIDER_DROP', 'POSSIBLE_ROLLOVER', 'MANUAL_SOS', 'PARKED_BIKE_FALL', 'POSSIBLE_TOWING', 'POSSIBLE_TAMPERING', 'DEVICE_OFFLINE_DURING_RENTAL', 'POSSIBLE_POTHOLE', 'POSSIBLE_DANGEROUS_CORNERING');

-- CreateEnum
CREATE TYPE "IncidentCategory" AS ENUM ('EMERGENCY', 'SECURITY', 'INFO');

-- CreateEnum
CREATE TYPE "IncidentState" AS ENUM ('OPEN', 'AWAITING_RESPONSE', 'RESOLVED_SAFE', 'ESCALATED', 'CLOSED', 'INFO_RECORDED');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'SAFE', 'HELP', 'TIMEOUT', 'OFFLINE_FALLBACK');

-- CreateEnum
CREATE TYPE "DecisionSource" AS ENUM ('APP', 'DEVICE_BUTTON', 'SERVER_TIMER', 'DEVICE_OFFLINE_TIMER');

-- CreateEnum
CREATE TYPE "LocationKind" AS ENUM ('LIVE', 'LAST_KNOWN', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "LocationSource" AS ENUM ('GPS', 'DEMO');

-- CreateEnum
CREATE TYPE "PhotoStatus" AS ENUM ('NOT_REQUESTED', 'PENDING', 'UPLOADING', 'AVAILABLE', 'FAILED');

-- CreateEnum
CREATE TYPE "ImageState" AS ENUM ('RESERVED', 'UPLOADING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "ResponseChoice" AS ENUM ('SAFE', 'HELP');

-- CreateEnum
CREATE TYPE "ResponseSource" AS ENUM ('APP', 'DEVICE_BUTTON');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('OWNER_SMS', 'CONTACT_SMS', 'CONTACT_CALL', 'DRIVER_PROMPT', 'OWNER_PUSH');

-- CreateEnum
CREATE TYPE "NotificationState" AS ENUM ('REQUESTED', 'QUEUED', 'AT_SUBMITTED', 'NETWORK_CONFIRMED', 'PROVIDER_ACCEPTED', 'CLIENT_RECEIVED', 'RESPONDED', 'FAILED', 'OUTCOME_UNKNOWN');

-- CreateEnum
CREATE TYPE "CommandType" AS ENUM ('SET_ASSIGNMENT', 'CLEAR_ASSIGNMENT', 'SET_CONFIG', 'INCIDENT_DECISION', 'DEMO_TRIGGER');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('QUEUED', 'DELIVERED', 'ACKED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone_e164" TEXT,
    "password_hash" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "consent_at" TIMESTAMPTZ,
    "disabled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "user_id" UUID NOT NULL,
    "notify_security" BOOLEAN NOT NULL DEFAULT true,
    "notify_info" BOOLEAN NOT NULL DEFAULT false,
    "alarm_sound" BOOLEAN NOT NULL DEFAULT true,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "emergency_contacts" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "emergency_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "pairing_code_hash" TEXT NOT NULL,
    "firmware_version" TEXT,
    "config_version" INTEGER NOT NULL DEFAULT 1,
    "applied_config_version" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL,
    "last_seen_at" TIMESTAMPTZ,
    "last_health" JSONB,
    "last_mode" TEXT,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bikes" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "device_id" UUID,
    "label" TEXT NOT NULL,
    "plate_no" TEXT,
    "status" "BikeStatus" NOT NULL DEFAULT 'AVAILABLE',
    "ignition" "IgnitionState" NOT NULL DEFAULT 'UNKNOWN',
    "ignition_changed_at" TIMESTAMPTZ,
    "last_lat" DOUBLE PRECISION,
    "last_lon" DOUBLE PRECISION,
    "last_fix_at" TIMESTAMPTZ,
    "last_speed_kph" DOUBLE PRECISION,
    "last_location_source" "LocationSource",
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bikes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rentals" (
    "id" UUID NOT NULL,
    "bike_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "emergency_contact_id" UUID NOT NULL,
    "owner_phone_snapshot" TEXT NOT NULL,
    "driver_name_snapshot" TEXT NOT NULL,
    "driver_phone_snapshot" TEXT,
    "contact_name_snapshot" TEXT NOT NULL,
    "contact_phone_snapshot" TEXT NOT NULL,
    "state" "RentalState" NOT NULL DEFAULT 'PENDING_SYNC',
    "assignment_version" INTEGER NOT NULL,
    "demo_override" BOOLEAN NOT NULL DEFAULT false,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "device_ack_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ,
    "end_requested_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,
    "distance_meters" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "last_distance_lat" DOUBLE PRECISION,
    "last_distance_lon" DOUBLE PRECISION,
    "last_distance_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rentals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_samples" (
    "id" BIGSERIAL NOT NULL,
    "bike_id" UUID NOT NULL,
    "rental_id" UUID,
    "fix_at" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "speed_kph" DOUBLE PRECISION,
    "hdop" DOUBLE PRECISION,
    "satellites" INTEGER,
    "valid" BOOLEAN NOT NULL,
    "source" "LocationSource" NOT NULL DEFAULT 'GPS',

    CONSTRAINT "location_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ignition_events" (
    "id" BIGSERIAL NOT NULL,
    "bike_id" UUID NOT NULL,
    "rental_id" UUID,
    "state" "IgnitionState" NOT NULL,
    "changed_at" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ignition_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "bike_id" UUID NOT NULL,
    "device_id" UUID,
    "rental_id" UUID,
    "driver_id" UUID,
    "owner_id" UUID NOT NULL,
    "type" "IncidentType" NOT NULL,
    "category" "IncidentCategory" NOT NULL,
    "state" "IncidentState" NOT NULL,
    "severity_score" INTEGER,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "time_source" TEXT NOT NULL,
    "ignition_at_event" "IgnitionState" NOT NULL DEFAULT 'UNKNOWN',
    "pre_event_speed_kph" DOUBLE PRECISION,
    "location_kind" "LocationKind" NOT NULL,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "fix_at" TIMESTAMPTZ,
    "fix_age_sec" INTEGER,
    "location_source" "LocationSource",
    "evidence" JSONB NOT NULL,
    "sensor_window" JSONB,
    "assignment_version" INTEGER,
    "owner_phone_snapshot" TEXT,
    "driver_name_snapshot" TEXT,
    "contact_name_snapshot" TEXT,
    "contact_phone_snapshot" TEXT,
    "server_question" BOOLEAN NOT NULL DEFAULT false,
    "question_sent_at" TIMESTAMPTZ,
    "response_deadline_at" TIMESTAMPTZ,
    "decision" "Decision" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "decision_source" "DecisionSource",
    "decided_at" TIMESTAMPTZ,
    "photo_status" "PhotoStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "integrity_hash" TEXT,
    "owner_ack_at" TIMESTAMPTZ,
    "owner_note" TEXT,
    "closed_at" TIMESTAMPTZ,
    "quarantined" BOOLEAN NOT NULL DEFAULT false,
    "quarantine_reason" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_images" (
    "id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "state" "ImageState" NOT NULL DEFAULT 'RESERVED',
    "expected_bytes" INTEGER NOT NULL,
    "received_bytes" INTEGER NOT NULL DEFAULT 0,
    "chunk_size" INTEGER NOT NULL,
    "sha256_expected" TEXT NOT NULL,
    "sha256_actual" TEXT,
    "storage_key" TEXT,
    "mime" TEXT NOT NULL DEFAULT 'image/jpeg',
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "incident_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_responses" (
    "id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "choice" "ResponseChoice" NOT NULL,
    "source" "ResponseSource" NOT NULL,
    "responder_user_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "device_time" TIMESTAMPTZ,
    "server_received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted" BOOLEAN NOT NULL,
    "reject_reason" TEXT,
    "synced_to_device_at" TIMESTAMPTZ,

    CONSTRAINT "driver_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "state" "NotificationState" NOT NULL DEFAULT 'REQUESTED',
    "recipient_masked" TEXT,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_attempts" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "state" "NotificationState" NOT NULL,
    "detail" TEXT,
    "device_time" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_commands" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "type" "CommandType" NOT NULL,
    "payload" JSONB NOT NULL,
    "incident_id" UUID,
    "status" "CommandStatus" NOT NULL DEFAULT 'QUEUED',
    "result" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ,
    "acked_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_nonces" (
    "device_id" UUID NOT NULL,
    "nonce" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_nonces_pkey" PRIMARY KEY ("device_id","nonce")
);

-- CreateTable
CREATE TABLE "push_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'android',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_resets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "key" TEXT NOT NULL,
    "user_id" UUID,
    "route" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" BIGSERIAL NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "meta" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_links" (
    "id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_e164_key" ON "users"("phone_e164");

-- CreateIndex
CREATE INDEX "emergency_contacts_driver_id_is_current_idx" ON "emergency_contacts"("driver_id", "is_current");

-- CreateIndex
CREATE UNIQUE INDEX "devices_code_key" ON "devices"("code");

-- CreateIndex
CREATE UNIQUE INDEX "bikes_device_id_key" ON "bikes"("device_id");

-- CreateIndex
CREATE INDEX "bikes_owner_id_idx" ON "bikes"("owner_id");

-- CreateIndex
CREATE INDEX "rentals_bike_id_state_idx" ON "rentals"("bike_id", "state");

-- CreateIndex
CREATE INDEX "rentals_driver_id_state_idx" ON "rentals"("driver_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "rentals_bike_id_assignment_version_key" ON "rentals"("bike_id", "assignment_version");

-- CreateIndex
CREATE INDEX "location_samples_rental_id_fix_at_idx" ON "location_samples"("rental_id", "fix_at");

-- CreateIndex
CREATE UNIQUE INDEX "location_samples_bike_id_fix_at_key" ON "location_samples"("bike_id", "fix_at");

-- CreateIndex
CREATE UNIQUE INDEX "ignition_events_bike_id_changed_at_key" ON "ignition_events"("bike_id", "changed_at");

-- CreateIndex
CREATE INDEX "incidents_owner_id_occurred_at_idx" ON "incidents"("owner_id", "occurred_at");

-- CreateIndex
CREATE INDEX "incidents_bike_id_occurred_at_idx" ON "incidents"("bike_id", "occurred_at");

-- CreateIndex
CREATE INDEX "incidents_state_response_deadline_at_idx" ON "incidents"("state", "response_deadline_at");

-- CreateIndex
CREATE INDEX "incidents_driver_id_occurred_at_idx" ON "incidents"("driver_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "incident_images_incident_id_key" ON "incident_images"("incident_id");

-- CreateIndex
CREATE UNIQUE INDEX "driver_responses_idempotency_key_key" ON "driver_responses"("idempotency_key");

-- CreateIndex
CREATE INDEX "driver_responses_incident_id_idx" ON "driver_responses"("incident_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_incident_id_kind_key" ON "notifications"("incident_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "notification_attempts_notification_id_attempt_no_state_key" ON "notification_attempts"("notification_id", "attempt_no", "state");

-- CreateIndex
CREATE INDEX "device_commands_device_id_status_created_at_idx" ON "device_commands"("device_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "device_nonces_created_at_idx" ON "device_nonces"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_tokens_token_key" ON "push_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "audit_events_created_at_idx" ON "audit_events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "share_links_token_hash_key" ON "share_links"("token_hash");

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_contacts" ADD CONSTRAINT "emergency_contacts_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bikes" ADD CONSTRAINT "bikes_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bikes" ADD CONSTRAINT "bikes_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_bike_id_fkey" FOREIGN KEY ("bike_id") REFERENCES "bikes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_emergency_contact_id_fkey" FOREIGN KEY ("emergency_contact_id") REFERENCES "emergency_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_samples" ADD CONSTRAINT "location_samples_bike_id_fkey" FOREIGN KEY ("bike_id") REFERENCES "bikes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_samples" ADD CONSTRAINT "location_samples_rental_id_fkey" FOREIGN KEY ("rental_id") REFERENCES "rentals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ignition_events" ADD CONSTRAINT "ignition_events_bike_id_fkey" FOREIGN KEY ("bike_id") REFERENCES "bikes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ignition_events" ADD CONSTRAINT "ignition_events_rental_id_fkey" FOREIGN KEY ("rental_id") REFERENCES "rentals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_bike_id_fkey" FOREIGN KEY ("bike_id") REFERENCES "bikes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_rental_id_fkey" FOREIGN KEY ("rental_id") REFERENCES "rentals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_images" ADD CONSTRAINT "incident_images_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_responses" ADD CONSTRAINT "driver_responses_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_responses" ADD CONSTRAINT "driver_responses_responder_user_id_fkey" FOREIGN KEY ("responder_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_nonces" ADD CONSTRAINT "device_nonces_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
