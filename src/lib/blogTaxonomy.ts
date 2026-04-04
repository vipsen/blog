/** Single-word category slugs (content collection enum). */
export const BLOG_CATEGORIES = ['ml', 'language', 'tooling', 'curation'] as const;
export type BlogCategory = (typeof BLOG_CATEGORIES)[number];

export const BLOG_CATEGORY_LABELS: Record<BlogCategory, string> = {
	ml: 'AI / ML',
	language: 'Language',
	tooling: 'Tooling',
	curation: 'Curation',
};

export const ARTICLE_KINDS = ['weekly-brief', 'spotlight'] as const;
export type ArticleKind = (typeof ARTICLE_KINDS)[number];

export const ARTICLE_KIND_LABELS: Record<ArticleKind, string> = {
	'weekly-brief': 'Weekly brief',
	spotlight: 'Spotlight',
};

/**
 * Use the raw tag string as the `[tag]` route param so prerendered paths match
 * in-page links (encoded vs decoded segments must not diverge).
 */
export function tagToParam(tag: string): string {
	return tag;
}

export function paramToTag(param: string): string {
	return param;
}
