<picture>
  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="./docs/hero-mobile-dark.svg">
  <source media="(prefers-color-scheme: light) and (max-width: 600px)" srcset="./docs/hero-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="./docs/hero-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./docs/hero-light.svg">
  <img alt="notebooklm-curator: takip edilen kanallardan yeni videolar NotebookLM kütüphanesine akıyor, tarama her kaynağı güncel, eskiyor veya bayat diye işaretliyor, bayat olanlar yalnızca onayla çıkıyor." src="./docs/hero-light.svg" width="100%">
</picture>

**NotebookLM kütüphaneni güncel tutar.** Claude'a bir YouTube kanalını takip etmesini söylersin,
yeni videolar not defterine gelir. Bir not defterini denetlemesini istersin, her kaynak konusuna
uygun bir raf ömrüne göre kontrol edilir. Onayın olmadan hiçbir şey silinmez.

Windows ve macOS'ta, **Claude Desktop** ve **Claude Code** içinde çalışır.
[English README](README.md)

> Google, NotebookLM'in adını Temmuz 2026'da Gemini Notebook olarak değiştirdi. Ürün ve not
> defterleri aynı; araç iki adla da çalışır.

## Kurulum

Gerekenler: **Google Chrome** (bildiğimiz masaüstü tarayıcı) ve NotebookLM kullandığın bir Google hesabı.

### Claude Desktop: tek tık, terminal yok

1. **[notebooklm-curator.mcpb](https://github.com/furkancakmakcreative/notebooklm-curator/releases/latest/download/notebooklm-curator.mcpb)** dosyasını indir.
2. Dosyaya çift tıkla. Claude Desktop bir kurulum penceresi açar, **Install** de.
   Pencere açılmazsa Claude Desktop'ta **Settings → Extensions** sayfasına git ve dosyayı o sayfaya sürükle.
3. YouTube API anahtarı alanını boş bırak. Zorunlu değil.

### Claude Code: tek komut

[Node.js](https://nodejs.org) 20 veya üstü gerekir. Terminale yapıştır:

```bash
claude mcp add --scope user notebooklm-curator -- npx -y github:furkancakmakcreative/notebooklm-curator
```

### Sonra, hangisini kullanıyorsan

Yeni bir sohbet aç ve şunu yaz:

> **NotebookLM Curator'ı kur.**

Claude neyin hazır olduğunu kontrol eder ve kalan adımlarda seni yönlendirir. Senden istenen tek
şey: bir kez Chrome penceresi açılır, orada Google hesabına giriş yaparsın ve Claude'a "tamam"
dersin. Sonrasında her şey arka planda çalışır.

## Ne diyebilirsin

| Sen dersin | Ne olur |
|---|---|
| "Not defterlerimi listele." | Tüm not defterleri, kaynak sayılarıyla. |
| "*Yapay Zeka* not defterimi denetle. Eskiyen var mı?" | Her kaynağa bir kategori ve raf ömrü verilir; bayat, eskiyen ve kopya kaynaklar listelenir. Hiçbir şey silinmez. |
| "Listelediğin bayat kaynakları kaldır." | Claude her başlığı seninle teyit eder, yalnızca onları kaldırır. |
| "@GoogleDevelopers kanalını *Yapay Zeka* not defterim için takip et." | Yeni yüklenen videolar onayına sunulmak üzere toplanır. Eski videolar eklenmez. |
| "Takip ettiğim kanallarda yeni video var mı?" | Takip edilen her kanal ve oynatma listesi kontrol edilir, yeniler listelenir. |
| "Yenileri ekle." | Onayladığın videolar, not defterinin kaynak sınırını aşmadan eklenir. |
| "Not defterime sor: ana argümanlar neler?" | NotebookLM'in cevabını getirir. |

## YouTube API anahtarı (isteğe bağlı)

Kanal ve oynatma listesi takibi anahtar **olmadan** çalışır: araç YouTube'un herkese açık akışını
okur, bu akış her kanalın en yeni 15 videosunu gösterir. Birkaç günde bir kontrol için bu yeterli.

Anahtar iki şey ekler: **denetimde yayın tarihleri** (NotebookLM bir videonun linkini göstermediği
için tarih başlıktan aranır) ve kanal ve listelerde **tüm geçmiş**. Ücretsizdir, yaklaşık beş dakika sürer:

1. [Google Cloud Console](https://console.cloud.google.com/)'u aç, isterse bir proje oluştur.
2. **APIs & Services → Library**, **YouTube Data API v3** ara, **Enable** de.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Yeni anahtara tıkla, **API restrictions** altında **Restrict key** seç, yalnızca
   **YouTube Data API v3** işaretle ve kaydet. Kısıtlanmış anahtar sadece herkese açık YouTube verisini okuyabilir.
5. Claude Desktop: **Settings → Extensions** altında eklentinin ayarlarını aç, anahtarı yapıştır.
   Claude Code: `claude mcp remove notebooklm-curator` çalıştır, sonra kurulum komutunu
   `--scope user` kısmından hemen sonra `-e YOUTUBE_API_KEY=anahtarin` ekleyerek tekrar çalıştır.

Anahtar senin bilgisayarında kalır, yalnızca `googleapis.com`'a gönderilir.

## Neyin bayat olduğuna nasıl karar verir

Tek bir "40 günden eski" kuralı iki yönde de yanılır: bir model duyurusu üç haftada eskir, tipografi
üzerine bir video üç yıl sonra da işe yarar. Bu yüzden raf ömrü kategoriye göre değişir:

| Kategori | Gün | Neler girer |
|---|---|---|
| `news` | 30 | duyurular, sürüm notları, haftalık özetler |
| `tactics` | 45 | kullanım limitleri, "hangi modeli kullanmalı" gibi hızla değişen tavsiyeler |
| `tool` | 60 | belirli bir sürüme bağlı araç kullanımı ve iş akışları |
| `tutorial` | 120 | kurslar, adım adım anlatımlar, teknik derinlemesine içerikler |
| `official` | 150 | Anthropic ve Claude kanallarından ürün özelliği videoları |
| `principle` | 1095 | teori, strateji, eskimeyen zanaat bilgisi |

Kategori başlıktan tahmin edilir (İngilizce ve Türkçe anahtar kelimeler). Her sayı değiştirilebilir,
örneğin: "denetle ama haberleri 14 günde bayat say". Raf ömrünün %75'i dolan kaynak `aging`
(eskiyor), sonrası `stale` (bayat), tarihi bulunamayan `unknown` (bilinmiyor) olur. Tarih asla tahmin edilmez.

## Güvenlik

- **Onayın olmadan hiçbir şey silinmez.** Silme aracı açık onay (`confirm: true`) olmadan çalışmaz ve
  Claude'a her başlığı tek tek sorması söylenir. Denetim salt okunurdur.
- **Kanal takibi eski videoları içeri almaz**, sen belirli sayıda yeni video istemedikçe (en fazla 50).
  Yeni videolar varsayılan olarak onayını bekler. Tam otomatik mod var; açmak ayrıca onay ister.
- **Senin bilgisayarında çalışır**, yalnızca bu aracın kullandığı ayrı bir Chrome profilinde. Şifren
  saklanmaz, sadece o profilin Google oturumu saklanır. Ana hesabın yerine araştırma için ayırdığın bir
  Google hesabıyla giriş yapmayı düşünebilirsin.
- **Google veya Anthropic ile bağlantısı yoktur.** Bunun için herkese açık bir NotebookLM API'si yok;
  araç NotebookLM sitesini bir insanın kullanacağı gibi kullanır. Google siteyi değiştirdiğinde bazı
  işlemler bir güncelleme gelene kadar çalışmayabilir.

## Bilinen sınırlar

- **Yalnızca Windows ve macOS.** Linux hedeflenmiyor.
- **Kaynak linkleri okunamaz.** NotebookLM sayfada bir kaynağın adresini hiç göstermez, bu yüzden kimlik
  olarak başlık kullanılır. Aynı başlıklı iki kaynak kopya olarak raporlanır; birini silmek için hangisi
  olduğunu belirtmen gerekir.
- **Tarih yalnızca YouTube için.** Web sayfaları ve PDF'ler denetimde her zaman `unknown` görünür.
- **Çok yeni veya altyazısız videolar eklenemeyebilir.** Otomatik mod varsayılan olarak 72 saat bekler.
- **Buton metinleri İngilizce ve Türkçe arayüzde eşleşir.** Başka bir dildeki NotebookLM arayüzünde bazı
  butonlar bulunamayabilir.
- **Bilgisayarın açık olması gerekir.** Takip edilen kanallar araç açıldığında ve sen istediğinde kontrol
  edilir. Kaçan kontroller bir sonraki açılışta telafi edilir; kayıp olmaz, sadece geç gelir.

Geliştirici ayrıntıları (elle kurulum, araç listesi, zamanlama, sürüm çıkarma) için
[İngilizce README](README.md#for-developers).

## Lisans

MIT
