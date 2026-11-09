CREATE TABLE `document_summaries` (
	`document_id` text PRIMARY KEY NOT NULL,
	`source_sha256` text NOT NULL,
	`extraction_parser` text NOT NULL,
	`extraction_parser_version` text NOT NULL,
	`extraction_extracted_at` text NOT NULL,
	`total_page_count` integer NOT NULL,
	`included_page_numbers_json` text NOT NULL,
	`included_page_ranges_json` text NOT NULL,
	`source_excerpt_byte_count` integer NOT NULL,
	`source_excerpt_truncated` integer NOT NULL,
	`source_coverage_warning` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`created_at` text NOT NULL,
	`overview_json` text NOT NULL,
	`contributions_json` text NOT NULL,
	`methods_json` text NOT NULL,
	`findings_json` text NOT NULL,
	`limitations_json` text NOT NULL,
	`warnings_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `document_summary_claims` (
	`document_id` text PRIMARY KEY NOT NULL,
	`owner_token` text NOT NULL,
	`expires_at` text NOT NULL
);
