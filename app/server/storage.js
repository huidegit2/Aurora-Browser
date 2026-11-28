const fs = require('fs');

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), 'utf8');
            return JSON.parse(JSON.stringify(fallback));
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return JSON.parse(JSON.stringify(fallback));
    }
}

function writeJson(filePath, data) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
}

module.exports = { readJson, writeJson };
