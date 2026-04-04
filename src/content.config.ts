import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { ARTICLE_KINDS, BLOG_CATEGORIES } from './lib/blogTaxonomy';

const blog = defineCollection({
	// Load Markdown and MDX files in the `src/content/blog/` directory.
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	// Type-check frontmatter using a schema
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
			category: z.enum(BLOG_CATEGORIES),
			articleKind: z.enum(ARTICLE_KINDS),
			tags: z.array(z.string()).default([]),
		}),
});

export const collections = { blog };
