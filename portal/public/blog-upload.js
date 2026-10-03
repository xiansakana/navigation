(function() {
    window.runBlogUploads = async function(items, worker, concurrency) {
        var results = new Array(items.length), cursor = 0, failure;
        await Promise.all(Array.from({ length: Math.min(concurrency || 2, items.length) }, async function() {
            while (!failure && cursor < items.length) {
                var index = cursor++;
                try { results[index] = await worker(items[index], index); }
                catch (error) { failure = failure || error; }
            }
        }));
        if (failure) { failure.uploaded = results.filter(Boolean); throw failure; }
        return results;
    };
})();
