CREATE TABLE `papers` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`arxiv_id` text NOT NULL,
	`title` text NOT NULL,
	`authors_json` text NOT NULL,
	`year` integer,
	`abstract` text NOT NULL,
	`url` text,
	`pdf_url` text,
	`saved_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `papers_source_identity` ON `papers` (`source`,`arxiv_id`);