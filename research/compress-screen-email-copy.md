# Screen and email compression copy

English copy proposal only. This document does not specify compression behavior or change the UI.

| UI state | Proposed copy |
|---|---|
| Mode name | Screen and email |
| Hint | Make a smaller PDF for sharing, email, or online forms. Stronger compression can reduce image detail. |
| Warning before processing | Not for print. This mode may change image colors and resolution. For print, choose a mode that preserves print colors. |
| Target size label, if supported | Target file size |
| Target size hint | Set the size you need. The result may still be larger than your target. |
| Successful result | File size: {originalSize} → {resultSize}. |
| Target met | Within your {targetSize} target. |
| Target not met | Still above your {targetSize} target. |
| No smaller result | This setting did not produce a smaller PDF. |
| Transformations heading | What changed |
| RGB conversion confirmed | Converted {imageCount} images to RGB. |
| Resolution reduction confirmed | Reduced resolution in {imageCount} images. |
| Image recompression confirmed | Recompressed {imageCount} images. |

## Display rules

- Show the warning before processing. Keep the current print-preserving option available.
- Use original and output byte counts from the actual result. Compare exact bytes before formatting the sizes for display. When no target is set, omit target status.
- Display transformation lines only when processing reports that the corresponding change actually occurred. A requested mode is not proof of a transformation. Do not describe converted images as an entire document color conversion.
- If the original is returned, show the no-smaller-result message. Do not label the original as compressed. Keep failure and cancellation distinct from this result.
- Use the existing size formatter and singular/plural rules. If a value cannot be determined, omit the corresponding line rather than guessing.
- Do not promise a percentage reduction, a guaranteed target, lossless output, or identical print color.
