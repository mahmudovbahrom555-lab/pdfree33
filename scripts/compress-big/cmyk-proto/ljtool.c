/* ljtool — libjpeg-turbo probe for the CMYK/grey prototype (PROTO-PREREG.md). Measurement only.
 *
 *   ljtool dec <in.jpg> <out.raw> [nofancy]   raw samples as stored (CMYK/YCCK → CMYK, grey → 1 ch),
 *                                            no inversion; prints the header facts as one JSON line
 *   ljtool enc <in.raw> <w> <h> <cmyk|ycck|gray> <quality> <1|2> <out.jpg>
 *                                            raw input as stored (Adobe convention: the caller inverts);
 *                                            sampling 1 = 4:4:4, 2 = 2×2 on components 2–3 (YCCK only)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <jpeglib.h>

static const char *cs_name(J_COLOR_SPACE c) {
  switch (c) { case JCS_GRAYSCALE: return "gray"; case JCS_RGB: return "rgb"; case JCS_YCbCr: return "ycbcr";
    case JCS_CMYK: return "cmyk"; case JCS_YCCK: return "ycck"; default: return "other"; }
}

static int dec(const char *in, const char *out, int nofancy) {
  FILE *f = fopen(in, "rb"); if (!f) return 2;
  struct jpeg_decompress_struct d; struct jpeg_error_mgr e;
  d.err = jpeg_std_error(&e); jpeg_create_decompress(&d);
  jpeg_save_markers(&d, JPEG_APP0 + 2, 0xFFFF);
  jpeg_stdio_src(&d, f); jpeg_read_header(&d, TRUE);
  int icc = 0; for (jpeg_saved_marker_ptr m = d.marker_list; m; m = m->next) if (m->marker == JPEG_APP0 + 2) icc = 1;
  J_COLOR_SPACE src = d.jpeg_color_space;
  if (src == JCS_CMYK || src == JCS_YCCK) d.out_color_space = JCS_CMYK;
  else if (src == JCS_GRAYSCALE) d.out_color_space = JCS_GRAYSCALE;
  else { fprintf(stderr, "not cmyk/ycck/gray\n"); return 3; }
  if (nofancy) d.do_fancy_upsampling = FALSE;
  printf("{\"w\":%u,\"h\":%u,\"components\":%d,\"jpeg_cs\":\"%s\",\"adobe\":%d,\"transform\":%d,\"progressive\":%d,\"icc\":%d,\"sampling\":[",
         d.image_width, d.image_height, d.num_components, cs_name(src), d.saw_Adobe_marker, d.Adobe_transform, d.progressive_mode, icc);
  for (int i = 0; i < d.num_components; i++) printf("%s\"%dx%d\"", i ? "," : "", d.comp_info[i].h_samp_factor, d.comp_info[i].v_samp_factor);
  printf("]}\n");
  jpeg_start_decompress(&d);
  FILE *o = fopen(out, "wb"); size_t rs = (size_t)d.output_width * d.output_components;
  JSAMPLE *row = malloc(rs);
  while (d.output_scanline < d.output_height) { JSAMPROW r = row; jpeg_read_scanlines(&d, &r, 1); fwrite(row, 1, rs, o); }
  free(row); fclose(o); jpeg_finish_decompress(&d); jpeg_destroy_decompress(&d); fclose(f);
  return 0;
}

static int enc(const char *in, int w, int h, const char *cs, int q, int samp, const char *out) {
  int nc = strcmp(cs, "gray") ? 4 : 1;
  size_t n = (size_t)w * h * nc; JSAMPLE *buf = malloc(n);
  FILE *f = fopen(in, "rb"); if (!f || fread(buf, 1, n, f) != n) return 2; fclose(f);
  struct jpeg_compress_struct c; struct jpeg_error_mgr e;
  c.err = jpeg_std_error(&e); jpeg_create_compress(&c);
  FILE *o = fopen(out, "wb"); jpeg_stdio_dest(&c, o);
  c.image_width = w; c.image_height = h; c.input_components = nc;
  c.in_color_space = nc == 4 ? JCS_CMYK : JCS_GRAYSCALE;
  jpeg_set_defaults(&c);
  jpeg_set_colorspace(&c, !strcmp(cs, "ycck") ? JCS_YCCK : !strcmp(cs, "cmyk") ? JCS_CMYK : JCS_GRAYSCALE);
  jpeg_set_quality(&c, q, TRUE);
  for (int i = 0; i < c.num_components; i++) { c.comp_info[i].h_samp_factor = 1; c.comp_info[i].v_samp_factor = 1; }
  if (samp == 2 && !strcmp(cs, "ycck")) { c.comp_info[0].h_samp_factor = 2; c.comp_info[0].v_samp_factor = 2; c.comp_info[3].h_samp_factor = 2; c.comp_info[3].v_samp_factor = 2; }
  jpeg_start_compress(&c, TRUE);
  while (c.next_scanline < c.image_height) { JSAMPROW r = buf + (size_t)c.next_scanline * w * nc; jpeg_write_scanlines(&c, &r, 1); }
  jpeg_finish_compress(&c); jpeg_destroy_compress(&c); fclose(o); free(buf);
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 4 && !strcmp(argv[1], "dec")) return dec(argv[2], argv[3], argc > 4 && !strcmp(argv[4], "nofancy"));
  if (argc == 9 && !strcmp(argv[1], "enc")) return enc(argv[2], atoi(argv[3]), atoi(argv[4]), argv[5], atoi(argv[6]), atoi(argv[7]), argv[8]);
  fprintf(stderr, "usage: see the header comment\n"); return 1;
}
