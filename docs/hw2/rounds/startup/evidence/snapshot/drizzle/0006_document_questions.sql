CREATE TABLE `document_question_claims` (
	`document_id` text NOT NULL,
	`normalized_question` text NOT NULL,
	`extraction_fingerprint` text NOT NULL,
	`owner_token` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_question_claim_identity` ON `document_question_claims` (`document_id`,`normalized_question`,`extraction_fingerprint`);--> statement-breakpoint
CREATE TABLE `document_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`question` text NOT NULL,
	`normalized_question` text NOT NULL,
	`source_sha256` text NOT NULL,
	`extraction_parser` text NOT NULL,
	`extraction_parser_version` text NOT NULL,
	`extraction_extracted_at` text NOT NULL,
	`extraction_fingerprint` text NOT NULL,
	`total_page_count` integer NOT NULL,
	`included_page_numbers_json` text NOT NULL,
	`included_page_ranges_json` text NOT NULL,
	`source_excerpt_byte_count` integer NOT NULL,
	`source_excerpt_truncated` integer NOT NULL,
	`source_coverage_warning` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`outcome` text NOT NULL,
	`answer_parts_json` text NOT NULL,
	`insufficient_source_reason` text,
	`warnings_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_questions_cache_identity` ON `document_questions` (`document_id`,`normalized_question`,`extraction_fingerprint`);--> statement-breakpoint
CREATE INDEX `document_questions_document_created_id` ON `document_questions` (`document_id`,`created_at`,`id`);