// api/stamp.js
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fetch = require('node-fetch');
const FormData = require('form-data');

const CLOUDINARY_UPLOAD_URL = process.env.CLOUDINARY_UPLOAD_URL;
const CLOUDINARY_UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;

async function uploadToCloudinary(buffer, filename = 'stamped.pdf') {
  const form = new FormData();
  form.append('file', buffer, { filename });
  if (CLOUDINARY_UPLOAD_PRESET) form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);

  const url = CLOUDINARY_UPLOAD_URL || `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`;
  const resp = await fetch(url, { method: 'POST', body: form });
  if (!resp.ok) throw new Error(`Cloudinary upload failed: ${resp.status} ${await resp.text()}`);
  return await resp.json();
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const {
      fileUrl,
      parsedFields = {},
      templateImageUrl,
      fieldPositions = {},
      stampFirstPageOnly = true
    } = req.body;

    if (!fileUrl) return res.status(400).json({ error: 'fileUrl required' });

    // fetch original PDF
    const fileResp = await fetch(fileUrl);
    if (!fileResp.ok) throw new Error('Failed to fetch original PDF');
    const fileBytes = await fileResp.arrayBuffer();

    // load pdf
    const pdfDoc = await PDFDocument.load(fileBytes);

    // embed titleblock image (if provided)
    let titleImg;
    if (templateImageUrl) {
      const imgResp = await fetch(templateImageUrl);
      if (imgResp.ok) {
        const imgBytes = await imgResp.arrayBuffer();
        if (templateImageUrl.toLowerCase().endsWith('.png')) {
          titleImg = await pdfDoc.embedPng(imgBytes);
        } else {
          titleImg = await pdfDoc.embedJpg(imgBytes);
        }
      }
    }

    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();
    const targetPages = stampFirstPageOnly ? [pages[0]] : pages;

    for (const page of targetPages) {
      const { width, height } = page.getSize();

      if (titleImg) {
        const scale = (fieldPositions._titleblockWidth || 600) / titleImg.width;
        const tbW = titleImg.width * scale;
        const tbH = titleImg.height * scale;
        const tbX = fieldPositions._titleblockX || 0;
        const tbY = fieldPositions._titleblockY || 0;
        page.drawImage(titleImg, { x: tbX, y: tbY, width: tbW, height: tbH });
      }

      // draw text fields
      for (const [field, cfg] of Object.entries(fieldPositions)) {
        if (field.startsWith('_')) continue; // meta keys
        const text = (parsedFields[field] || '').toString();
        if (!text) continue;
        const x = Number(cfg.x || 10);
        const y = Number(cfg.y || 10);
        const size = Number(cfg.size || 8);
        const maxWidth = cfg.maxWidth || 300;
        page.drawText(text, {
          x, y, size, font: helvetica, color: rgb(0, 0, 0), maxWidth
        });
      }
    }

    const outBytes = await pdfDoc.save();

    // upload to Cloudinary and return URL
    const uploadResult = await uploadToCloudinary(Buffer.from(outBytes), 'stamped.pdf');
    res.status(200).json({ stampedUrl: uploadResult.secure_url || uploadResult.url, cloudinary: uploadResult });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
