const zlib = require('zlib'),
        fs = require('fs'),
        crypto = require('crypto'),
        {encryptValue, genKey} = require('./lib/crypt'),
        {prompt} = require('./lib/prompt'),
        {buildFileStat, walkDirGen, isNotDirectory, ifNotExist, globToRegex} = require("./lib/dir"),
        http = require('http'),
        {join, normalize, sep} = require("path");

const run = async () => {
    const signalTraps = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGABRT', 'SIGTERM', 'SIGUSR2'];
    signalTraps.forEach(function (signal) {
        process.on(signal, function () {
            process.exit(0)
        });
    });
    const {serverUrl, passphrase, salt, directory, includeGlob, dryRun} = await prompt([
        {
            type: 'input',
            name: 'serverUrl',
            message: 'Enter the server URL',
            validate: async (str) => {
                const urlRegex = /^(http:\/\/)?([a-zA-Z0-9.-]+)(:[0-9]+)?\/$/;
                return urlRegex.test(str) ? true : 'Try again, the URL was not valid'
            },
        },
        {
            type: 'password',
            name: 'passphrase',
            message: 'Enter a Passphrase',
            validate: async (str) => {
                return (Buffer.byteLength(str, 'utf8') > 32) ? true : `Try again, the passphrase was only ${Buffer.byteLength(str, 'utf8')} bytes and needs to be 32 Bytes`
            },
        },
        {
            type: 'password',
            name: 'salt',
            message: 'Enter a Salt',
            validate: async (str) => {
                return (Buffer.byteLength(str, 'utf8') > 16) ? true : `Try again, the salt was only ${Buffer.byteLength(str, 'utf8')} bytes and needs to be 16 Bytes`
            },
        },
        {
            type: 'confirm',
            name: 'dryRun',
            message: 'Execute a dry run only',
            def: true,
        },
        {
            type: 'input',
            name: 'directory',
            message: 'Enter a directory',
            validate: async (str) => {
                if (ifNotExist(str)) {
                    return 'Try again, the Directory does not exist.'
                }
                if (isNotDirectory(str)) {
                    return `Try again, ${str} does not appear to be a Directory.`
                }
                return true
            },
            filter: (str) => {
                if (normalize(str).endsWith(sep)) {
                    return str
                }
                return normalize(join(str, sep))
            },
        },
        {
            type: 'confirm',
            name: 'includeGlob',
            message: 'Include Globs',
            def: false,
        },
    ])
    const globPatterns = [];
    if (includeGlob) {
        const answer = await prompt([
            {
                type: 'editor',
                name: 'globPatterns',
                message: 'You are about to enter your OS default editor. Enter a glob pattern, one per line, save the file, and exit to continue. Hit enter to start.',
                validate: async (str) => {
                    return (str.length > 0) ? true : `Try again, the glob pattern was empty`
                },
                filter: (str) => {
                    return str.split('\n').filter(Boolean).map(globPattern => globPattern.trim())
                },
            }
        ])
        globPatterns.push(...answer.globPatterns.map(globToRegex).map(globPattern => new RegExp(globPattern)))
    } else {
        globPatterns.push(new RegExp('.*', 'igm'))
    }

    const encryptionAlgorithm = 'aes-256-cbc'

    /**
     * the Key is what comes from the Server starting up...
     * @type {string}
     */
    const encryptionKey = genKey(passphrase, salt)
    const iv = crypto.randomBytes(16)
    const isMatch = (filePath) => globPatterns.some(globPattern => globPattern.test(filePath))
    for await (let {filePath, perms} of walkDirGen(directory, '.')) {
        if (!isMatch(filePath)) {
            continue
        }
        if (dryRun) {
            console.log(filePath);
            continue
        }
        if (!perms.o.r || !perms.g.r || !perms.u.r) {
            console.log(`Skipping ${filePath}, insufficient permissions to read the file`)
            continue
        }
        console.log(`Sending ${filePath}`)
        /**
         * this is a little complicated:
         *   the Meta Header does not have an IV, which is absolutely required if the data inside repeats.
         *   SO, I slap in a NONCE. Yes a nonce should be the first thing, and this is JSON... but
         *   it will do for now.
         *
         *   I do generate an IV ( as an attribute in the JSON payload ) as part of the Meta Header,
         *   this IV is used to encrypt the following data in the stream. which is good, because in theory
         *   we could transmit a file that has a bunch of repeating stuff in it and could be cracked.
         */
        const nonce = {
            [crypto.randomBytes(16).toString('hex')]: crypto.randomBytes(16).toString('hex')
        }
        const meta = encryptValue(JSON.stringify({
            ...nonce,
            ...buildFileStat(directory, filePath),
            iv: iv.toString('hex')
        }), passphrase, salt)
        await new Promise((resolve, reject) => {
            const req = http.request(serverUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    meta
                }
            }, (res) => {
                let statusCode = res.statusCode;
                let body = '';
                res.on('data', (chunk) => {
                    body += chunk;
                });
                res.on('end', () => {
                    resolve({body, statusCode})
                });
            });
            req.on('error', reject);
            fs.createReadStream(normalize(join(directory, filePath)))
                    .pipe(crypto.createCipheriv(encryptionAlgorithm, encryptionKey, iv, {}))
                    .pipe(zlib.createGzip())
                    .pipe(req)
        })
    }
}
run()
        .then(() => {
            console.log('Done')
            process.exit(0)
        })
        .catch(error => {
            console.error('Error:', error)
            process.exit(1)
        })