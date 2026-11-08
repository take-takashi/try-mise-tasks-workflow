export async function cli(description, action, { usage = false } = {}) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
      console.log(description);
      return;
    }
    if (args.length && !usage) throw new Error('不明な引数です: ' + args.join(' '));
    if (args.length && usage && (process.env.usage_base === undefined || process.env.usage_head === undefined)) {
      throw new Error('引数は mise run から指定してください。');
    }
    await action();
  } catch (error) {
    console.error('エラー: ' + error.message);
    process.exitCode = 1;
  }
}
