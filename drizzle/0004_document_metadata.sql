CREATE TABLE `document_metadata` (
	`document_id` text PRIMARY KEY NOT NULL,
	`source_sha256` text NOT NULL,
	`extraction_parser` text NOT NULL,
	`extraction_parser_version` text NOT NULL,
	`extraction_extracted_at` text NOT NULL,
	`selected_pages_json` text NOT NULL,
	`source_excerpt_byte_count` integer NOT NULL,
	`source_excerpt_clipped` integer NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`generated_at` text NOT NULL,
	`title` text,
	`authors_json` text,
	`year` integer,
	`abstract` text,
	`evidence_json` text NOT NULL,
	`warnings_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `document_metadata_claims` (
	`document_id` text PRIMARY KEY NOT NULL,
	`owner_token` text NOT NULL,
	`expires_at` text NOT NULL
);
