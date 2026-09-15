export declare const FORMAT_VERSION: "0.1";
export declare const EntityKind: {
    readonly Project: "project";
    readonly Library: "library";
    readonly Book: "book";
    readonly Annotation: "annotation";
    readonly Note: "note";
    readonly Source: "source";
    readonly Publication: "publication";
    readonly PublishedAnnotation: "published-annotation";
    readonly PublishedBook: "published-book";
};
export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];
export type EntityIdPrefix = "ann" | "pub" | "project" | "note" | "capture";
export interface Project {
    type: "project";
    version: "0.1";
    id: `project:${string}`;
    title: string;
    description?: string;
    visibility?: "private" | "public";
    readme?: string;
}
export interface Library {
    type: "library";
    version: "0.1";
    name: string;
    booksPath?: string;
    annotationsPath?: string;
}
export interface Book {
    type: "book";
    version: "0.1";
    id: `isbn:${string}`;
    title: string;
    authors: string[];
    isbn13: string;
    publisher?: string;
    year?: number;
    coverImage?: string;
}
export interface Annotation {
    type: "annotation";
    version: "0.1";
    id: `ann:${string}`;
    source: `isbn:${string}`;
    location: {
        page?: number;
        path?: string;
    };
    quote: string;
    comment?: string;
    attribution?: string;
    captureImage?: string;
    rawOcr?: string;
    localPath?: string;
    deviceMetadata?: Record<string, unknown>;
    privateMemo?: string;
    unpublishedComments?: string[];
}
export interface Note {
    type: "note";
    version: "0.1";
    id: `note:${string}`;
    title: string;
    path: string;
}
export interface Source {
    type: "source";
    version: "0.1";
    id: `source:${string}`;
    kind: "book" | "paper" | "web";
    title: string;
    path?: string;
    url?: string;
}
export interface Publication {
    type: "publication";
    version: "0.1";
    id: `pub:${string}`;
    title: string;
    source: {
        repository: string;
        output: string;
    };
    publishedAt: string;
    url?: string;
    annotations?: `ann:${string}`[];
    sources?: `isbn:${string}`[];
}
export interface PublishedAnnotation {
    type: "published-annotation";
    version: "0.1";
    id: `ann:${string}`;
    source: `isbn:${string}`;
    location: {
        page?: number;
        path?: string;
    };
    quote: string;
    comment?: string;
    attribution?: string;
}
export interface PublishedBook {
    type: "published-book";
    version: "0.1";
    id: `isbn:${string}`;
    title: string;
    authors: string[];
    isbn13: string;
    publisher?: string;
    year?: number;
}
export type Entity = Project | Library | Book | Annotation | Note | Source | Publication | PublishedAnnotation | PublishedBook;
export type EntityForKind<K extends EntityKind> = Extract<Entity, {
    type: K;
}>;
export type ValidationResult<T = unknown> = {
    valid: true;
    value: T;
} | {
    valid: false;
    errors: readonly string[];
};
export declare function generateEntityId(prefix: EntityIdPrefix): `${EntityIdPrefix}:${string}`;
export declare function validateEntity<K extends EntityKind>(kind: K, value: unknown): ValidationResult<EntityForKind<K>>;
export declare function assertValidEntity<K extends EntityKind>(kind: K, value: unknown): EntityForKind<K>;
export declare function parseAndValidate<K extends EntityKind>(kind: K, yamlText: string): ValidationResult<EntityForKind<K>>;
/** Publication boundaries are explicit allowlists, never object spreads. */
export declare function toPublishedAnnotation(annotation: Annotation): PublishedAnnotation;
export declare function toPublishedBook(book: Book): PublishedBook;
//# sourceMappingURL=index.d.ts.map