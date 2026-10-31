# Collecting F-commerce sellers from the Meta Ad Library (by hand)

This is a **manual** process. A person looks at each page and types one row. Do not use scripts, browser extensions,
auto-clickers or "export" tools on Facebook: Meta's terms forbid automated collection, and this project does not scrape.

## 1. Open the Ad Library
1. Go to https://www.facebook.com/ads/library
2. Country: **Bangladesh**. Ad category: **All ads**.
3. Search one keyword at a time. Good keywords:
   - English: `home delivery`, `cash on delivery`, `COD`, `order now`, `inbox for price`, `all over Bangladesh`
   - Bangla: `ক্যাশ অন ডেলিভারি`, `হোম ডেলিভারি`, `অর্ডার করতে`, `ইনবক্স করুন`, `সারা বাংলাদেশে`
   - Product words: `শাড়ি`, `থ্রি পিস`, `পাঞ্জাবি`, `কসমেটিকস`, `gadget`, `baby products`, `home made food`
4. Optional filter: Active status = **Active ads** (only pages advertising now).

## 2. For each seller page, fill one row in `ad_library_collection_template.csv`
Copy the template first (for example `collected_2026-11-01_rahim.csv`) and keep the header row.

| Column | Required | What to write |
|---|---|---|
| PageName | yes | Page name exactly as shown |
| PageUrl | yes | Click the page name, copy the page link (`https://www.facebook.com/<page>` or an Instagram link). Not a post or ad link. |
| ProductType | yes | One of: `facebook_clothing`, `facebook_cosmetics`, `instagram_fashion`, `online_electronics`, `online_grocery`, `online_baby_products`, `online_footwear`, `ecommerce_brand`, `facebook_food`, `online_gifts`, `other` |
| SearchKeyword | yes | The keyword you searched |
| SeenOn | yes | Date you saw it, `YYYY-MM-DD` |
| StatedDistrict | no | Only if the page itself says where it is (e.g. "Mirpur, Dhaka" -> `Dhaka`). Never guess. |
| PhoneShownOnPage | no | Only a business number printed on the page/ad. Leave empty if unsure. |
| CollectedBy | yes | Your name |
| Notes | no | Anything useful (e.g. "also has website", "looks inactive") |

## 3. Rules
- **Skip** personal profiles, political/NGO/government pages, news pages, and pages selling only abroad.
- **Do not copy ad text or images.** Page name + link is enough.
- **Never invent** a phone, district or product type. Empty is fine.
- One page = one row. Repeated pages are fine: the import skips duplicates.
- Delete the example row.

## 4. Import
Save the file in this folder, then ask Claude (or run `npm run import-adlibrary -- data/fcommerce/<file>.csv`).
Rows that fail checks go to `<file>.rejected.csv` with the reason, so they can be fixed and imported again.

Records imported this way are labelled **"Meta Ad Library (manual)"**: the page was seen advertising, but the business
itself is **not verified**. Phone numbers of individual sellers may be personal data; check Bangladeshi data-protection
rules before selling contact lists.
