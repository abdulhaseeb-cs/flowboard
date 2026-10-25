-- =====================================================================
-- FlowBoard database schema
-- Mounted at /docker-entrypoint-initdb.d/ in the postgres container.
-- Runs ONLY when the "pgdata" volume is empty (first start). Later starts
-- reuse the data already in the volume => data persistence.
-- =====================================================================

-- ---------- Accounts ----------
CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(80)  NOT NULL,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    avatar_color  VARCHAR(7)   NOT NULL DEFAULT '#6366f1',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------- Workspaces (teams) & membership ----------
CREATE TABLE workspaces (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(80) NOT NULL,
    invite_code VARCHAR(16) NOT NULL UNIQUE,
    created_by  INTEGER     NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE workspace_members (
    workspace_id INTEGER     NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         VARCHAR(10) NOT NULL DEFAULT 'member'
                 CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

-- ---------- Projects (boards) ----------
CREATE TABLE projects (
    id           SERIAL PRIMARY KEY,
    workspace_id INTEGER      NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         VARCHAR(80)  NOT NULL,
    key          VARCHAR(6)   NOT NULL,           -- e.g. "WEB" => tasks WEB-1, WEB-2 ...
    description  TEXT         NOT NULL DEFAULT '',
    color        VARCHAR(7)   NOT NULL DEFAULT '#6366f1',
    task_seq     INTEGER      NOT NULL DEFAULT 0, -- last issued task number
    created_by   INTEGER      NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, key)
);

-- Board columns. "position" is a float so items can be inserted between two
-- others without renumbering (fractional indexing).
CREATE TABLE board_columns (
    id         SERIAL PRIMARY KEY,
    project_id INTEGER          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       VARCHAR(40)      NOT NULL,
    position   DOUBLE PRECISION NOT NULL,
    wip_limit  INTEGER          CHECK (wip_limit IS NULL OR wip_limit > 0),
    is_done    BOOLEAN          NOT NULL DEFAULT FALSE  -- tasks here count as completed
);

CREATE TABLE labels (
    id         SERIAL PRIMARY KEY,
    project_id INTEGER     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       VARCHAR(30) NOT NULL,
    color      VARCHAR(7)  NOT NULL,
    UNIQUE (project_id, name)
);

-- ---------- Tasks ----------
CREATE TABLE tasks (
    id            SERIAL PRIMARY KEY,
    project_id    INTEGER          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    column_id     INTEGER          NOT NULL REFERENCES board_columns(id) ON DELETE RESTRICT,
    number        INTEGER          NOT NULL,
    title         VARCHAR(200)     NOT NULL,
    description   TEXT             NOT NULL DEFAULT '',
    priority      VARCHAR(10)      NOT NULL DEFAULT 'medium'
                  CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    assignee_id   INTEGER          REFERENCES users(id) ON DELETE SET NULL,
    reporter_id   INTEGER          NOT NULL REFERENCES users(id),
    due_date      DATE,
    story_points  INTEGER          CHECK (story_points IS NULL OR story_points BETWEEN 0 AND 100),
    position      DOUBLE PRECISION NOT NULL,
    completed_at  TIMESTAMPTZ,
    due_notified  BOOLEAN          NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, number)
);

CREATE TABLE task_labels (
    task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, label_id)
);

CREATE TABLE checklist_items (
    id         SERIAL PRIMARY KEY,
    task_id    INTEGER          NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    text       VARCHAR(200)     NOT NULL,
    done       BOOLEAN          NOT NULL DEFAULT FALSE,
    position   DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE TABLE comments (
    id         SERIAL PRIMARY KEY,
    task_id    INTEGER     NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at  TIMESTAMPTZ
);

-- Metadata only — the file bytes live on the shared "uploads" Docker volume
CREATE TABLE attachments (
    id            SERIAL PRIMARY KEY,
    task_id       INTEGER      NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id       INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_name VARCHAR(255) NOT NULL,
    stored_name   VARCHAR(64)  NOT NULL UNIQUE,
    mime_type     VARCHAR(100) NOT NULL,
    size_bytes    BIGINT       NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------- Audit trail & notifications ----------
CREATE TABLE activity (
    id         BIGSERIAL PRIMARY KEY,
    project_id INTEGER     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id    INTEGER     REFERENCES tasks(id) ON DELETE CASCADE,
    user_id    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
    action     VARCHAR(40) NOT NULL,
    details    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE notifications (
    id         BIGSERIAL PRIMARY KEY,
    user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id   INTEGER      REFERENCES users(id) ON DELETE SET NULL,
    type       VARCHAR(30)  NOT NULL,   -- assigned | mentioned | due_soon | overdue | commented
    title      VARCHAR(200) NOT NULL,
    body       TEXT         NOT NULL DEFAULT '',
    link       VARCHAR(255) NOT NULL DEFAULT '',
    read_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------- Indexes for the hot queries ----------
CREATE INDEX idx_members_user       ON workspace_members (user_id);
CREATE INDEX idx_projects_ws        ON projects (workspace_id);
CREATE INDEX idx_columns_project    ON board_columns (project_id, position);
CREATE INDEX idx_tasks_board        ON tasks (project_id, column_id, position);
CREATE INDEX idx_tasks_assignee     ON tasks (assignee_id) WHERE completed_at IS NULL;
CREATE INDEX idx_tasks_due          ON tasks (due_date) WHERE completed_at IS NULL AND due_notified = FALSE;
CREATE INDEX idx_checklist_task     ON checklist_items (task_id);
CREATE INDEX idx_comments_task      ON comments (task_id);
CREATE INDEX idx_attachments_task   ON attachments (task_id);
CREATE INDEX idx_activity_project   ON activity (project_id, created_at DESC);
CREATE INDEX idx_activity_task      ON activity (task_id);
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);
