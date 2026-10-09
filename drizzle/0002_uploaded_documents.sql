CREATE TABLE `uploaded_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`byte_count` integer NOT NULL,
	`sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploaded_documents_object_key` ON `uploaded_documents` (`object_key`);--> statement-breakpoint
CREATE INDEX `uploaded_documents_uploaded_at_id` ON `uploaded_documents` (`uploaded_at`,`id`);