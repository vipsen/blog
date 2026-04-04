import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import { SITE_DESCRIPTION, SITE_TITLE } from '../consts';
import { joinBasePath } from '../utils/siteBaseUrl';

/** @astrojs/rss の channel link に base が乗らないため、トップの絶対URLにする */
function rssChannelSite(origin, baseUrl) {
	const b = String(baseUrl || '/').replace(/^\/+|\/+$/g, '');
	const o = String(origin).replace(/\/+$/, '');
	if (!b) return `${o}/`;
	return new URL(`${b}/`, `${o}/`).href;
}

export async function GET() {
	const site = rssChannelSite(import.meta.env.SITE, import.meta.env.BASE_URL);

	const posts = (await getCollection('blog')).sort(
		(a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
	);
	return rss({
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
		site,
		items: posts.map((post) => ({
			title: post.data.title,
			description: post.data.description,
			pubDate: post.data.pubDate,
			link: `${joinBasePath(post.id)}/`,
			categories: [
				post.data.category,
				post.data.articleKind,
				...post.data.tags,
			],
		})),
	});
}
