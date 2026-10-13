// Entry point kept for backwards compatibility with docs and npm scripts.
// Must be safe to import in tests (no side effects on require()).
function start() {
    // Defer loading the actual runner until invoked, so requiring this module
    // does not start the bot.
    // eslint-disable-next-line global-require
    require('./index');
}

module.exports = { start };

if (require.main === module) {
    start();
}

