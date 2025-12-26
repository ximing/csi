/**
 * save_as_pdf (protocol §4.13): Page.printToPDF. The base64 payload goes
 * back to the daemon, which writes it to disk with a title-derived default
 * file name (protocol §5).
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached, sendCommand } from '../debugger-session';
import { getCurrentTab } from '../tab-manager';

/** Paper sizes in inches [width, height]. */
const PAPER_SIZES: Record<string, [number, number]> = {
  letter: [8.5, 11],
  legal: [8.5, 14],
  a4: [8.27, 11.69],
  a3: [11.69, 16.54],
  tabloid: [11, 17],
};

export class SaveAsPdfTool implements Tool {
  readonly name = 'save_as_pdf';

  async execute(args: ToolArgs): Promise<unknown> {
    await ensureAttached((await getCurrentTab()).id!);

    const paperFormat = ((args.paper_format as string | undefined) || 'letter').toLowerCase();
    const [paperWidth, paperHeight] = PAPER_SIZES[paperFormat] ?? PAPER_SIZES.letter!;

    const scale = typeof args.scale === 'number' ? args.scale : 1;
    if (scale < 0.1 || scale > 2) {
      throw new Error(`save_as_pdf: scale must be in [0.1, 2.0], got ${scale}`);
    }

    const pdf = await sendCommand<{ data?: string }>('Page.printToPDF', {
      printBackground: args.print_background !== false,
      landscape: !!args.landscape,
      scale,
      paperWidth,
      paperHeight,
      preferCSSPageSize: true,
    });
    if (!pdf?.data) throw new Error('save_as_pdf: CDP Page.printToPDF returned no data');

    let pageTitle = '';
    try {
      const titleResult = await sendCommand<{ result?: { value?: string } }>(
        'Runtime.evaluate',
        { expression: 'document.title', returnByValue: true },
      );
      pageTitle = titleResult.result?.value ?? '';
    } catch {
      // title is cosmetic — ignore failures
    }

    return {
      data: pdf.data,
      mimeType: 'application/pdf',
      dataLength: pdf.data.length,
      pageTitle,
      requestedFileName: (args.file_name as string | undefined) || '',
    };
  }
}
