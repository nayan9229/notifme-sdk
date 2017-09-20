/* https://github.com/aws/aws-sdk-js/blob/master/lib/signers/v4.js */
import {hmac, sha256} from '../crypto'
import v4Credentials from './v4_credentials'
import querystring from 'querystring'

/**
 * @api private
 */
const expiresHeader = 'presigned-expires'

/**
 * @api private
 */
export default class AWSSignersV4 {
  algorithm = 'AWS4-HMAC-SHA256'

  constructor (request, serviceName, options) {
    this.request = request
    this.serviceName = serviceName
    options = options || {}
    this.signatureCache = typeof options.signatureCache === 'boolean' ? options.signatureCache : true
    this.operation = options.operation
  }

  addAuthorization (credentials, date) {
    const datetime = date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:-]|\.\d{3}/g, '')

    if (this.isPresigned()) {
      this.updateForPresigned(credentials, datetime)
    } else {
      this.addHeaders(credentials, datetime)
    }

    this.request.headers['Authorization'] = this.authorization(credentials, datetime)
  }

  addHeaders (credentials, datetime) {
    this.request.headers['X-Amz-Date'] = datetime
    if (credentials.sessionToken) {
      this.request.headers['x-amz-security-token'] = credentials.sessionToken
    }
  }

  updateForPresigned (credentials, datetime) {
    const credString = this.credentialString(datetime)
    const qs = {
      'X-Amz-Date': datetime,
      'X-Amz-Algorithm': this.algorithm,
      'X-Amz-Credential': credentials.accessKeyId + '/' + credString,
      'X-Amz-Expires': this.request.headers[expiresHeader],
      'X-Amz-SignedHeaders': this.signedHeaders()
    }

    if (credentials.sessionToken) {
      qs['X-Amz-Security-Token'] = credentials.sessionToken
    }

    if (this.request.headers['Content-Type']) {
      qs['Content-Type'] = this.request.headers['Content-Type']
    }
    if (this.request.headers['Content-MD5']) {
      qs['Content-MD5'] = this.request.headers['Content-MD5']
    }
    if (this.request.headers['Cache-Control']) {
      qs['Cache-Control'] = this.request.headers['Cache-Control']
    }

    // need to pull in any other X-Amz-* headers
    Object.keys(this.request.headers).forEach((key) => {
      const value = this.request.headers[key]
      if (key === expiresHeader) return
      if (this.isSignableHeader(key)) {
        const lowerKey = key.toLowerCase()
        // Metadata should be normalized
        if (lowerKey.indexOf('x-amz-meta-') === 0) {
          qs[lowerKey] = value
        } else if (lowerKey.indexOf('x-amz-') === 0) {
          qs[key] = value
        }
      }
    })

    const sep = this.request.path.indexOf('?') >= 0 ? '&' : '?'
    this.request.path += sep + querystring(qs)
  }

  authorization (credentials, datetime) {
    const parts = []
    const credString = this.credentialString(datetime)
    parts.push(this.algorithm + ' Credential=' + credentials.accessKeyId + '/' + credString)
    parts.push('SignedHeaders=' + this.signedHeaders())
    parts.push('Signature=' + this.signature(credentials, datetime))
    return parts.join(', ')
  }

  signature (credentials, datetime) {
    const signingKey = v4Credentials.getSigningKey(
      credentials,
      datetime.substr(0, 8),
      this.request.region,
      this.serviceName,
      this.signatureCache
    )
    return hmac(signingKey, this.stringToSign(datetime), 'hex')
  }

  stringToSign (datetime) {
    const parts = []
    parts.push('AWS4-HMAC-SHA256')
    parts.push(datetime)
    parts.push(this.credentialString(datetime))
    parts.push(this.hexEncodedHash(this.canonicalString()))
    return parts.join('\n')
  }

  canonicalString () {
    const parts = []
    let pathname = this.request.path
    if (this.serviceName !== 's3') {
      const uriEscape = (string) => {
        let output = encodeURIComponent(string)
        output = output.replace(/[^A-Za-z0-9_.~\-%]+/g, escape)
        // AWS percent-encodes some extra non-standard characters in a URI
        output = output.replace(/[*]/g, function (ch) {
          return '%' + ch.charCodeAt(0).toString(16).toUpperCase()
        })
        return output
      }
      pathname = pathname.split('/').map(uriEscape).join('/')
    }

    parts.push(this.request.method)
    parts.push(pathname)
    parts.push(this.request.search)
    parts.push(this.canonicalHeaders() + '\n')
    parts.push(this.signedHeaders())
    parts.push(this.hexEncodedBodyHash())
    return parts.join('\n')
  }

  canonicalHeaders () {
    const headers = []
    Object.keys(this.request.headers).forEach((key) => {
      headers.push([key, this.request.headers[key]])
    })
    headers.sort(function (a, b) {
      return a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1
    })
    const parts = []
    headers.forEach((item) => {
      const key = item[0].toLowerCase()
      if (this.isSignableHeader(key)) {
        const value = item[1]
        if (typeof value === 'undefined' || value === null || typeof value.toString !== 'function') {
          throw new Error('Header ' + key + ' contains invalid value')
        }
        parts.push(key + ':' +
        this.canonicalHeaderValues(value.toString()))
      }
    })
    return parts.join('\n')
  }

  canonicalHeaderValues (values) {
    return values.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '')
  }

  signedHeaders () {
    const keys = []
    Object.keys(this.request.headers).forEach((key) => {
      key = key.toLowerCase()
      if (this.isSignableHeader(key)) keys.push(key)
    })
    return keys.sort().join(';')
  }

  credentialString (datetime) {
    return v4Credentials.createScope(
      datetime.substr(0, 8),
      this.request.region,
      this.serviceName
    )
  }

  hexEncodedHash (string) {
    return sha256(string, 'hex')
  }

  hexEncodedBodyHash () {
    const request = this.request
    if (this.isPresigned() && this.serviceName === 's3' && !request.body) {
      return 'UNSIGNED-PAYLOAD'
    } else if (request.headers['X-Amz-Content-Sha256']) {
      return request.headers['X-Amz-Content-Sha256']
    } else {
      return this.hexEncodedHash(this.request.body || '')
    }
  }

  unsignableHeaders = [
    'authorization',
    'content-type',
    'content-length',
    'user-agent',
    expiresHeader,
    'expect',
    'x-amzn-trace-id'
  ]

  isSignableHeader (key) {
    if (key.toLowerCase().indexOf('x-amz-') === 0) return true
    return this.unsignableHeaders.indexOf(key) < 0
  }

  isPresigned () {
    return this.request.headers[expiresHeader]
  }
}
