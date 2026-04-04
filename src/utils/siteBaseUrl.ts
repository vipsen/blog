/**
 * Join a path segment to Astro's base. Safe whether BASE_URL ends with "/" or not.
 */
export function joinBasePath(pathSegment: string): string {
	const base = import.meta.env.BASE_URL;
	const seg = pathSegment.replace(/^\/+|\/+$/g, '');
	if (!seg) {
		return base;
	}
	const root = base.replace(/\/+$/, '');
	if (root === '') {
		return `/${seg}`;
	}
	return `${root}/${seg}`;
}

/**
 * Strip deploy base from a pathname or same-origin path. Result has no leading "/"; "" means index.
 */
export function pathRelativeToBase(
	pathname: string,
	base: string = import.meta.env.BASE_URL,
): string {
	const root = base.replace(/\/+$/, '') || '/';
	const p =
		pathname.length > 1 && pathname.endsWith('/')
			? pathname.slice(0, -1)
			: pathname;

	if (root === '/' || root === '') {
		return p.replace(/^\/+|\/+$/g, '') || '';
	}

	const prefix = `${root}/`;
	if (p === root) {
		return '';
	}
	if (p.startsWith(prefix)) {
		return p.slice(prefix.length).replace(/\/+$/g, '') || '';
	}
	return p.replace(/^\/+|\/+$/g, '') || '';
}
