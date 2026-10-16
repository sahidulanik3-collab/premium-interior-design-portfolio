# SAHIDUL ANIK — Premium Interior Portfolio 🇧🇩

Minimal, warm, liveable luxury interiors — Dhaka. 100% static website, GitHub Pages ready. No build, no server, no error.

**Live site:** `https://USERNAME.github.io/REPO-NAME/` (Pages ON করার পর link বসবে)

---

## 📁 Koyta file lagbe (ei repo te)

| File | Kaj |
|---|---|
| `index.html` | Main portfolio website |
| `admin.html` | Full CMS admin panel (password: `anik123`, first login er por change koro) |
| `404.html` | GitHub Pages er error page |
| `.nojekyll` | Pages-এ Jekyll OFF রাখে — **delete korba na**, naile `admin.html` / `_` folder serve issue hobe |
| `.gitignore` | Unnecessary / secret file push atkay |
| `robots.txt` | Google crawling allow |
| `LICENSE` | MIT |
| `.github/workflows/pages.yml` | Push korlei auto-deploy |

> ⚠️ `leadforge/` folder ta alada Node.js SaaS project. Portfolio repo te ota **push korar dorkar nai**. Shudhu uporer file gulo diye notun repo banao — tahole Pages clean thakbe.

---

## 🚀 GitHub-e upload + Live link (5 min, Bangla guide)

### Option A — GitHub website diye (sohoj, terminal lagbe na)

1. https://github.com → **New repository** → Name: `portfolio` (ja iccha) → **Public** → **Create**
2. **uploading an existing file** → ei folder er file gulo drag & drop:
   `index.html`, `admin.html`, `404.html`, `.nojekyll`, `.gitignore`, `robots.txt`, `LICENSE`, `README.md`, `.github/` folder
   - ⚠️ `leadforge/` folder ta upload korba **na**
   - ⚠️ `.nojekyll` hidden file — Windows e show hidden files ON kore nio
3. **Commit changes**
4. Repo → **Settings → Pages** → **Source:** `GitHub Actions` select koro (workflow file already ache, auto deploy hobe)
   - Jodi `Deploy from a branch` use koro: Branch `main` + folder `/ (root)` → Save
5. 1–2 min wait → upore green ✅ banner e live link paba:
   `https://tomar-username.github.io/portfolio/`

### Option B — Terminal diye

```powershell
cd "portfolio-folder-path"
git init
git add index.html admin.html 404.html .nojekyll .gitignore robots.txt LICENSE README.md .github
git commit -m "Premium portfolio live"
git branch -M main
git remote add origin https://github.com/USERNAME/REPO-NAME.git
git push -u origin main
```

Tarpor Settings → Pages → Source `GitHub Actions` → 1 min ei site live.

---

## ✏️ Edit korba kivabe?

- Browser e `admin.html` kholo → password `anik123` → sob section edit → Save (browser localStorage e save hoy).
- **Important:** GitHub Pages static hosting — ek browser e change korle onno device e dekhabe **na**. Permanent change chaile `index.html` er vitore default text edit kore abar push koro.
- Password change: Admin Panel → Settings → Change password.

## 🔗 Nijer domain lagale (optional)

Repo root e `CNAME` naam e file banao, vitore shudhu domain likho:

```
www.tomardomain.com
```

Tarpor domain DNS e CNAME → `USERNAME.github.io` point koro.

## 🛠️ Kono error asle?

| Problem | Fix |
|---|---|
| 404 / blank page | Repo te `index.html` root e ache kina check koro, Pages source `/(root)` kina dekho |
| `admin.html` khule na | Link `./admin.html` relative — domain er sathe `/admin.html` jog kore kholo |
| CSS asche na | Internet lagbe (Tailwind/Font CDN online) — offline e khali design dekhabe |
| Change onno phone e dekha jay na | Normal — localStorage per-browser. `index.html` edit + push koro |

---

Made with care in Dhaka • © 2026 Sahidul Anik
