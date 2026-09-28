import type en from "./messages/en.json";
import type { routing } from "./i18n/routing";

// Typed messages: every t("…") key is checked against messages/en.json (ur.json has the same keys).
declare module "next-intl" {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: typeof en;
  }
}
