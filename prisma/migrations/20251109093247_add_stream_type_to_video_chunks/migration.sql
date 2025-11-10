-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT,
    "location" TEXT,
    "bio" TEXT,
    "avatar" TEXT,
    "skills" JSONB,
    "interests" JSONB,
    "target_role" TEXT,
    "prompt_iq_score" INTEGER NOT NULL DEFAULT 0,
    "total_points" INTEGER NOT NULL DEFAULT 0,
    "level" TEXT DEFAULT 'Beginner',
    "assessments_completed" INTEGER NOT NULL DEFAULT 0,
    "achievements" JSONB,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "joined_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "onboarding_completed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruiter_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "company_id" TEXT,
    "position" TEXT,
    "department" TEXT,
    "avatar" TEXT,
    "onboarding_completed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruiter_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT,
    "size" TEXT,
    "location" TEXT,
    "website" TEXT,
    "description" TEXT,
    "logo" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "email" TEXT,
    "company_id" TEXT,
    "company_name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'recruiter',
    "used_by" TEXT,
    "used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "template_hash" TEXT NOT NULL,
    "role" TEXT,
    "tech_stack" JSONB,
    "level" TEXT,
    "template_spec" JSONB NOT NULL,
    "suggested_assessments" JSONB,
    "docker_image" TEXT,
    "docker_image_built" BOOLEAN NOT NULL DEFAULT false,
    "webcontainer_ready" BOOLEAN NOT NULL DEFAULT false,
    "build_status" TEXT NOT NULL DEFAULT 'pending',
    "build_error" TEXT,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessments" (
    "id" TEXT NOT NULL,
    "job_title" TEXT,
    "company_id" TEXT,
    "job_description" TEXT,
    "role" TEXT,
    "tech_stack" JSONB,
    "level" TEXT,
    "template_id" TEXT,
    "template" JSONB,
    "source_url" TEXT,
    "source_type" TEXT,
    "assessment_type" TEXT DEFAULT 'recruiter',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "session_code" TEXT NOT NULL,
    "candidate_id" TEXT,
    "candidate_name" TEXT,
    "candidate_email" TEXT,
    "recruiter_email" TEXT,
    "assessment_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "time_limit" INTEGER NOT NULL DEFAULT 3600,
    "selected_llm" TEXT,
    "final_code" TEXT,
    "expires_at" TIMESTAMP(3),
    "last_activity_at" TIMESTAMP(3),
    "tab_switch_count" INTEGER NOT NULL DEFAULT 0,
    "last_tab_switch_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_snapshots" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "code" TEXT NOT NULL,
    "line_count" INTEGER NOT NULL,
    "language" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_chunks" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "stream_type" TEXT NOT NULL DEFAULT 'screenshare',
    "url" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "problem_id" INTEGER,
    "code" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "test_results" JSONB,
    "score" INTEGER NOT NULL DEFAULT 0,
    "passed_tests" INTEGER NOT NULL DEFAULT 0,
    "total_tests" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_interactions" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model" TEXT,
    "prompt_text" TEXT,
    "response_text" TEXT,
    "tokens_used" INTEGER,
    "code_snippet" TEXT,
    "code_line_number" INTEGER,
    "code_before" TEXT,
    "code_after" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_insights" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "watcher" JSONB,
    "extractor" JSONB,
    "sanity" JSONB,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_profiles_user_id_key" ON "candidate_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "recruiter_profiles_user_id_key" ON "recruiter_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_key" ON "invitations"("token");

-- CreateIndex
CREATE INDEX "invitations_token_idx" ON "invitations"("token");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "templates_template_hash_key" ON "templates"("template_hash");

-- CreateIndex
CREATE INDEX "templates_template_hash_idx" ON "templates"("template_hash");

-- CreateIndex
CREATE INDEX "templates_role_level_idx" ON "templates"("role", "level");

-- CreateIndex
CREATE INDEX "templates_build_status_idx" ON "templates"("build_status");

-- CreateIndex
CREATE INDEX "assessments_level_idx" ON "assessments"("level");

-- CreateIndex
CREATE INDEX "assessments_role_idx" ON "assessments"("role");

-- CreateIndex
CREATE INDEX "assessments_is_active_idx" ON "assessments"("is_active");

-- CreateIndex
CREATE INDEX "assessments_template_id_idx" ON "assessments"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_session_code_key" ON "sessions"("session_code");

-- CreateIndex
CREATE INDEX "sessions_session_code_idx" ON "sessions"("session_code");

-- CreateIndex
CREATE INDEX "sessions_status_idx" ON "sessions"("status");

-- CreateIndex
CREATE INDEX "sessions_assessment_id_idx" ON "sessions"("assessment_id");

-- CreateIndex
CREATE INDEX "sessions_last_activity_at_idx" ON "sessions"("last_activity_at");

-- CreateIndex
CREATE INDEX "code_snapshots_session_id_idx" ON "code_snapshots"("session_id");

-- CreateIndex
CREATE INDEX "events_session_id_idx" ON "events"("session_id");

-- CreateIndex
CREATE INDEX "events_event_type_idx" ON "events"("event_type");

-- CreateIndex
CREATE INDEX "video_chunks_session_id_idx" ON "video_chunks"("session_id");

-- CreateIndex
CREATE INDEX "video_chunks_session_id_stream_type_chunk_index_idx" ON "video_chunks"("session_id", "stream_type", "chunk_index");

-- CreateIndex
CREATE INDEX "submissions_session_id_idx" ON "submissions"("session_id");

-- CreateIndex
CREATE INDEX "submissions_problem_id_idx" ON "submissions"("problem_id");

-- CreateIndex
CREATE INDEX "ai_interactions_session_id_idx" ON "ai_interactions"("session_id");

-- CreateIndex
CREATE INDEX "ai_interactions_event_type_idx" ON "ai_interactions"("event_type");

-- CreateIndex
CREATE INDEX "ai_interactions_timestamp_idx" ON "ai_interactions"("timestamp");

-- CreateIndex
CREATE INDEX "ai_interactions_session_id_timestamp_idx" ON "ai_interactions"("session_id", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "agent_insights_session_id_key" ON "agent_insights"("session_id");

-- CreateIndex
CREATE INDEX "agent_insights_session_id_idx" ON "agent_insights"("session_id");

-- CreateIndex
CREATE INDEX "agent_insights_computed_at_idx" ON "agent_insights"("computed_at");

-- AddForeignKey
ALTER TABLE "candidate_profiles" ADD CONSTRAINT "candidate_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiter_profiles" ADD CONSTRAINT "recruiter_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiter_profiles" ADD CONSTRAINT "recruiter_profiles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_snapshots" ADD CONSTRAINT "code_snapshots_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_chunks" ADD CONSTRAINT "video_chunks_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interactions" ADD CONSTRAINT "ai_interactions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_insights" ADD CONSTRAINT "agent_insights_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
