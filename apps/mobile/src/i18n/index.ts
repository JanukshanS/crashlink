/**
 * i18n (§4.2, Appendix D).
 *
 * English is complete; Sinhala and Tamil carry the emergency strings, which are
 * the ones that matter when someone is lying in the road. Everything else falls
 * back to English rather than showing a key - a blank button on the emergency
 * screen would be worse than an English one.
 *
 * Appendix D: have a native speaker verify the si/ta strings before the demo.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import si from './si.json';
import ta from './ta.json';

export const SUPPORTED_LANGUAGES = ['en', 'si', 'ta'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<Language, string> = {
  en: 'English',
  si: 'සිංහල',
  ta: 'தமிழ்',
};

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    si: { translation: si },
    ta: { translation: ta },
  },
  lng: 'en',
  fallbackLng: 'en',
  // A missing si/ta key falls back to English instead of rendering the key.
  returnEmptyString: false,
  interpolation: { escapeValue: false },
  compatibilityJSON: 'v4',
});

export const setLanguage = async (language: Language): Promise<void> => {
  await i18n.changeLanguage(language);
};

export default i18n;
