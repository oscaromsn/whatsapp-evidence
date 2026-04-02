// =============================================================================
// Ingest Module - Type Definitions
// All shared types for the WhatsApp zip ingest pipeline
// =============================================================================

// ===== CLI Options =====

export type SplitInterval = "1w" | "2w" | "1mo" | "3mo" | "1y";

export interface IngestOptions {
	input: string;
	output: string;
	split: SplitInterval;
	layout: "by-period" | "by-contact";
	media: "none" | "audio" | "images" | "all";
	disclaimer: boolean;
	force: boolean;
	self: string | null;
	timezone: string;
	dateFormat: "DD/MM" | "MM/DD" | null;
	aliases: Map<string, string>;
	concurrency: number;
	regenerate: boolean;
	contact: string | null;
	dryRun: boolean;
	quiet: boolean;
	verbose: boolean;
}

// ===== Parsed Chat Data =====

export type MessageType = "text" | "media" | "system" | "deleted";

export type MediaSubtype =
	| "audio"
	| "image"
	| "video"
	| "document"
	| "sticker"
	| "location"
	| "contact"
	| "poll";

export type SystemSubtype =
	| "encryption"
	| "membership"
	| "admin"
	| "call"
	| "other";

export interface ParsedMessage {
	lineRange: [number, number];
	timestamp: string; // naive ISO: "2026-03-01T14:30:45"
	sender: string; // raw sender name, empty for system messages
	content: string;
	type: MessageType;
	subtype: MediaSubtype | SystemSubtype | null;
	mediaFile: string | null;
	isMediaOmitted: boolean;
	edited: boolean;
	replyTo: string | null;
}

export interface ParseResult {
	messages: ParsedMessage[];
	detectedFormat: "DD/MM" | "MM/DD";
	warnings: string[];
}

export type ZipLanguage = "pt-br" | "en";

// ===== Zip Extraction =====

export interface ExtractedZip {
	contactName: string;
	chatLogPath: string;
	mediaFiles: string[];
	encoding: "utf-8" | "latin-1";
	zipFilename: string;
}

// ===== Evidence Index (.whatsapp-evidence.json) =====

export interface EvidenceIndex {
	version: 1;
	config: IndexConfig;
	contacts: Record<string, ContactEntry>;
	messages: Record<string, MessageEntry>;
	mediaProcessing: Record<string, MediaEntry>;
}

export interface IndexConfig {
	split: SplitInterval;
	layout: "by-period" | "by-contact";
	timezone: string;
	self: string | null;
	aliases: Record<string, string>;
}

export interface ContactEntry {
	type: "individual" | "group";
	sourceZips: string[];
	messageCount: number;
	sanitizedName: string;
	dateFormat: "DD/MM" | "MM/DD";
	encoding: string;
}

export interface MessageEntry {
	seq: number;
	timestamp: string;
	sender: string;
	contact: string;
	type: MessageType;
	subtype: MediaSubtype | SystemSubtype | null;
	mediaFile: string | null;
	mediaProcessed: boolean;
	replyTo: string | null;
	edited: boolean;
	sourceZip: string;
	sourceLineRange: [number, number];
	period: string;
}

export type MediaStatus = "pending" | "processed" | "skipped" | "failed";

export interface MediaEntry {
	status: MediaStatus;
	type: string;
	sourceZip: string;
	originalFilename: string;
	transcription: string | null;
}

// ===== Rendering =====

export interface RenderOptions {
	disclaimer: boolean;
	selfName: string | null;
	aliases: Map<string, string>;
	isGroup: boolean;
}

export interface RenderedMessage {
	timestamp: string;
	sender: string;
	content: string;
	type: MessageType;
	subtype: MediaSubtype | SystemSubtype | null;
	mediaFile: string | null;
	isMediaOmitted: boolean;
	edited: boolean;
	replyTo: string | null;
	transcription: string | null;
	mediaExists: boolean;
}
