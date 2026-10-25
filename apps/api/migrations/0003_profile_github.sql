-- Public profiles can show the owner's GitHub avatar and a link to their GitHub account (on unless turned off).
ALTER TABLE profiles ADD COLUMN show_github INTEGER NOT NULL DEFAULT 1;
