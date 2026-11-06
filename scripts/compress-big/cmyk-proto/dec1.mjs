import fs from 'fs';
const { JpegImage } = await import(process.argv[2]);
const j = new JpegImage({ decodeTransform: null, colorTransform: -1 }); j.parse(new Uint8Array(fs.readFileSync(process.argv[3])));
fs.writeFileSync(process.argv[4], j.getData({ width: j.width, height: j.height, forceRGB: false, isSourcePDF: true }));
