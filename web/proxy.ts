import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

// Locale routing for the public site. The worker API, feeds and static files are excluded.
export default createMiddleware(routing);

export const config = {
  matcher: ["/((?!api|admin|_next|_vercel|fonts|snapshots|icon|apple-icon|opengraph-image|twitter-image|.*\\..*).*)"],
};
