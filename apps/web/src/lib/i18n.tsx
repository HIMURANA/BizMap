import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Lang = 'en' | 'bn';
const STR = {
  explore: ['Explore', 'খুঁজুন'], lists: ['Lists', 'তালিকা'], exports: ['Exports', 'এক্সপোর্ট'], campaigns: ['Campaigns', 'ক্যাম্পেইন'],
  inbox: ['Inbox', 'ইনবক্স'], reports: ['Reports', 'রিপোর্ট'], alerts: ['Alerts', 'সতর্কতা'], settings: ['Settings', 'সেটিংস'],
  search_placeholder: ['Search name or phone…', 'নাম বা ফোন নম্বর লিখুন…'], filters: ['Filters', 'ফিল্টার'], reset: ['Reset', 'রিসেট'],
  location: ['Location', 'অবস্থান'], category: ['Category', 'ক্যাটাগরি'], contact: ['Contact details', 'যোগাযোগ'], quality: ['Data quality', 'ডেটার মান'],
  source: ['Source', 'উৎস'], advanced: ['Advanced', 'অন্যান্য'], division: ['Division', 'বিভাগ'], district: ['District', 'জেলা'], upazila: ['Upazila / thana', 'উপজেলা / থানা'],
  area: ['Dhaka area', 'ঢাকার এলাকা'], radius: ['Radius search', 'ব্যাসার্ধে খুঁজুন'], results: ['results', 'টি ফলাফল'], map: ['Map', 'ম্যাপ'], table: ['Table', 'টেবিল'], split: ['Split', 'দুটোই'],
  add_to_list: ['Add to list', 'তালিকায় যোগ'], export: ['Export', 'এক্সপোর্ট'], selected: ['selected', 'টি নির্বাচিত'], credits: ['credits', 'ক্রেডিট'],
  save_view: ['Save view', 'ভিউ সেভ'], saved_views: ['Saved views', 'সেভ করা ভিউ'], has: ['Has', 'আছে'], verified_only: ['Verified only', 'শুধু যাচাইকৃত'],
  phone: ['Phone', 'ফোন'], email: ['Email', 'ইমেইল'], website: ['Website', 'ওয়েবসাইট'], facebook: ['Facebook', 'ফেসবুক'], instagram: ['Instagram', 'ইনস্টাগ্রাম'],
  call: ['Call', 'কল'], calls: ['Calls', 'কল তালিকা'], whatsapp: ['WhatsApp', 'হোয়াটসঅ্যাপ'], record_status: ['Record status', 'রেকর্ডের অবস্থা'], ready: ['Ready', 'প্রস্তুত'], lead: ['Lead (unconfirmed)', 'লিড (অনিশ্চিত)'],
  review: ['Needs review', 'যাচাই দরকার'], score: ['Confidence score', 'নির্ভরযোগ্যতা স্কোর'], fcommerce: ['F-commerce candidates only', 'শুধু এফ-কমার্স'],
  nothing: ['No businesses match these filters.', 'এই ফিল্টারে কোনো ব্যবসা পাওয়া যায়নি।'], not_exhaustive: ['Not an exhaustive directory: empty means no public data was found.', 'এটি সম্পূর্ণ তালিকা নয়: খালি মানে কোনো পাবলিক তথ্য পাওয়া যায়নি।'],
} satisfies Record<string, [string, string]>;
export type Key = keyof typeof STR;

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (k: Key) => string }>({ lang: 'en', setLang: () => {}, t: (k) => STR[k][0] });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => { try { return (localStorage.getItem('lang') as Lang) || 'en'; } catch { return 'en'; } });
  useEffect(() => { document.documentElement.lang = lang; try { localStorage.setItem('lang', lang); } catch { /* private mode */ } }, [lang]);
  return <Ctx.Provider value={{ lang, setLang, t: (k) => STR[k][lang === 'bn' ? 1 : 0] }}>{children}</Ctx.Provider>;
}
export const useI18n = () => useContext(Ctx);
