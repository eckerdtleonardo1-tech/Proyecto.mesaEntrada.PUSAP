const https = require('https');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CSS_DIR = path.join(PUBLIC_DIR, 'css');
const WEBFONTS_DIR = path.join(PUBLIC_DIR, 'webfonts');

// Crear directorios si no existen
[PUBLIC_DIR, CSS_DIR, WEBFONTS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Directorio creado: ${dir}`);
    }
});

const downloadFile = (urlStr, dest, modifyFn = null) => {
    return new Promise((resolve, reject) => {
        https.get(urlStr, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                let redirectUrl = response.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    const parsed = new URL(urlStr);
                    redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
                }
                console.log(`Redirecting ${urlStr} to ${redirectUrl}`);
                return downloadFile(redirectUrl, dest, modifyFn).then(resolve).catch(reject);
            }
            
            if (response.statusCode !== 200) {
                return reject(new Error(`Failed to get '${url}' (${response.statusCode})`));
            }

            let data = [];
            
            if (modifyFn) {
                response.on('data', chunk => data.push(chunk));
                response.on('end', () => {
                    let text = Buffer.concat(data).toString('utf8');
                    text = modifyFn(text);
                    fs.writeFileSync(dest, text);
                    console.log(`Descargado y modificado: ${dest}`);
                    resolve();
                });
            } else {
                const file = fs.createWriteStream(dest);
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    console.log(`Descargado: ${dest}`);
                    resolve();
                });
            }
        }).on('error', err => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
};

const assets = [
    {
        url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
        dest: path.join(CSS_DIR, 'fontawesome.min.css'),
        modifyFn: (text) => text.replace(/\.\.\/webfonts\//g, '/webfonts/')
    },
    {
        url: 'https://cdn.tailwindcss.com',
        dest: path.join(CSS_DIR, 'tailwind.min.css')
    },
    {
        url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/webfonts/fa-solid-900.woff2',
        dest: path.join(WEBFONTS_DIR, 'fa-solid-900.woff2')
    },
    {
        url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/webfonts/fa-regular-400.woff2',
        dest: path.join(WEBFONTS_DIR, 'fa-regular-400.woff2')
    },
    {
        url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/webfonts/fa-brands-400.woff2',
        dest: path.join(WEBFONTS_DIR, 'fa-brands-400.woff2')
    }
];

async function downloadAll() {
    console.log('Iniciando descarga de assets...');
    for (const asset of assets) {
        try {
            await downloadFile(asset.url, asset.dest, asset.modifyFn);
        } catch (error) {
            console.error(`Error descargando ${asset.url}:`, error.message);
        }
    }
    console.log('Descarga completada.');
}

downloadAll();
