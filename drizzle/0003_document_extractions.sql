CREATE TABLE `document_extractions` (
	`document_id` text PRIMARY KEY NOT NULL,
	`source_sha256` text NOT NULL,
	`parser` text NOT NULL,
	`parser_version` text NOT NULL,
	`extracted_at` text NOT NULL,
	`page_count` integer NOT NULL,
	`pages_json` text NOT NULL
);
