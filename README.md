# Telegram Community Landing

Landing page Next.js yang dibuat ulang dengan layout bergaya halaman komunitas Telegram: header gelap, banner gradient, preview, dua tombol CTA, tab Media/Berkas/Tautan, dan gallery responsive.

## Menjalankan

```bash
npm install
npm run dev
```

Buka `http://localhost:3001`.

## Mengubah link Telegram

Edit `components/StitchLanding.tsx` pada bagian:

```ts
const GROUP_URL = 'https://t.me/your_group';
const ADMIN_URL = 'https://t.me/your_admin';
```

Ganti dengan tautan Telegram yang benar.

## Mengganti gambar

Gambar utama saat ini menggunakan:

`public/stitch/mockup-b1edc6c7a8404b5295c324184c2882a9.png`

Kamu dapat menggantinya dengan gambar milikmu sendiri dan menyesuaikan path di `components/StitchLanding.tsx`.

## Catatan keamanan

Versi ini hanya menyediakan landing page dan tautan Telegram. Endpoint pengumpulan password/OTP/session Telegram serta komponen terkait telah dikeluarkan dari distribusi ini.
