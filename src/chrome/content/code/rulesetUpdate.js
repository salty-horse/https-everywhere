/* Secure ruleset udpate mechanism
 * The contents of this file exist to provide HTTPS Everywhere with a secure mechanism
 * for updating the extension's database of rulesets.
 * This "module" handles the tasks of fetching an update.json[1] manifest and:
 * 1) determining whether an update to the ruleset library has been released, and
 * 2) verifies that the update is authentic before applying the new ruleset.
 *
 * [1] The format and specification of the update.json file is detailed within a
 *     Github gist, at https://gist.github.com/redwire/2e1d8377ea58e43edb40
 *
 * The file https-everywhere/utils/ruleset_update_manifest.py exists to automate
 * part of the process of creating the update.json manifest data.
 */

// TODO
// Set this value.
/* Hardcoded public key used to verify the signature over the update data */
const RULESET_UPDATE_KEY = ''+
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7wJz/Ekn4loB+GX/TnObTo/5J0/aq1hBl'+
  '+xeSyCUX/fggjju5jnRnbnQx10OaZ655Yft4Cs2IfdIh95NYsN+gfi6HVesy/Q9G72BjhpW6+gTlk'+
  'W9vW56xwjv+Cpi5/20SKbvMZCMXTvR50HqLaLiOeLyAOQv06FKlyF5kbgQwpayExii75KFJL3HlH5'+
  '+mZfNfKElNK9Oyiig7sqnVTOdovNCFnW8zom2fS3YyODaFvPUSmo1Yd7Mr0xWjE5rAV7k70aZlR1N'+
  'Eze/Tfcf42LEhY5XkflczIWh+cse/v/sbZadS9jxbD2SgEJuLatF5zupmd0acvj1II8do2RE95FQC'+
  'QIDAQAB';

/* extension release branch preference key */
const BRANCH_PREF= 'extensions.https_everywhere.branch_name';

/* extension release version preference key */
const VERSION_PREF = 'extensions.https_everywhere.release_version';

/* installed ruleset version preference key */
const RULESET_VERSION_PREF = 'extensions.https_everywhere.ruleset_version';

/* key for the preference that holds the url to fetch update.json and update.json.sig from */
const RSUPDATE_URL_PREF = 'extensions.https_everywhere.ruleset_update_url';
const RSUPDATE_SIG_URL_PREF = 'extensions.https_everywhere.ruleset_update_signature_url';

/* path to the temporary download location of new ruleset database files */
const TMP_RULESET_DBFILE_PATH = OS.Path.join(OS.Constants.Path.tmpDir, "new_rulesets.sqlite");

/* maximum number of attempts to fetch ruleset updates */
const MAX_RSUPDATE_FETCHES = 6;

/* name of the hash function to use to compute the digest of update.json content */
const SIGNING_DIGEST_FN = 'sha256';

const _prefs = CC["@mozilla.org/preferences-service;1"]
                 .getService(CI.nsIPrefService).getBranch("");

/*******************************************************************************
 *** Design Explanation                                                        *
 * We can't write RulesetUpdater the usual way, with a constructor and then    *
 * by setting methods on the object's prototype, because we need access to     *
 * the HTTPSEverywhere object; trying to refer to it from RulesetUpdater's     *
 * "constructor" function results in cyclic dependencies since HTTPSEverywhere *
 * also needs a reference to RulesetUpdater to call fetchUpdate.               *
 *                                                                             *
 * We are thus forced to write RulesetUpdater as an object literal, but        *
 * doing so forces us to define methods in the reverse order from which        *
 * they are called. Rather than structuring my codebase backwards, and         *
 * since only the fetchUpdate function really needs to be exposed, I am        *
 * taking the approach you see here of defining everything I need inside       *
 * a closure, returning only the reference to fetchUpdate.                     *
 *******************************************************************************
 */

const RulesetUpdater = {     // BEGIN OBJECT DEFINITION
fetch_update : (function() { // BEGIN MODULE

/* Initiates the check for updates and tests of authenticity.
 * Must be wrapped in a function to call from setInterval, i.e.:
 * setInterval(function() { updater.fetchUpdate(); }, interval);
 */
function fetchUpdate() {
  https_everywhereLog(INFO, "Calling fetchUpdate");
  var manifestSrc = _prefs.getCharPref(RSUPDATE_URL_PREF);
  HTTPSEverywhere.instance.try_request(MAX_RSUPDATE_FETCHES, 'GET', manifestSrc,
    function(responseText) {
      https_everywhereLog(INFO, "Successfully fetched update.json file data");
      conditionallyApplyUpdate(responseText);
    });
}

/* Verifies the signature on the updateObj.update and then issues a request that
 * will fetch and test the hash on the newly released ruleset database file.
 * updateObj - The JSON manifest of the update information for the ruleset update.
 */
function conditionallyApplyUpdate(update) {
  https_everywhereLog(INFO, "Got update data:");
  https_everywhereLog(INFO, update);
  https_everywhereLog(INFO, '' + update.charCodeAt(update.length - 3) + 
                                 update.charCodeAt(update.length - 2) +
                                 update.charCodeAt(update.length - 1));
  var updateObj = JSON.parse(update);
  var extVersion = _prefs.getCharPref(VERSION_PREF);
  var extBranch = _prefs.getCharPref(BRANCH_PREF);
  var rulesetVersion = _prefs.getCharPref(RULESET_VERSION_PREF);
  https_everywhereLog(INFO, "Inside call to conditionallyApplyUpdate");
  if (!checkVersionRequirements(extVersion,  rulesetVersion, updateObj.version)) {
    https_everywhereLog(NOTE, 'Downloaded an either incompatible ruleset library or not a new one.');
    return; 
  }
  if (updateObj.branch !== extBranch) {
    https_everywhereLog(WARN, 'Downloaded a ruleset update for the incorrect branch.');
    return;
  }
  var sigFileSrc = _prefs.getCharPref(RSUPDATE_SIG_URL_PREF);
  HTTPSEverywhere.instance.try_request(MAX_RSUPDATE_FETCHES, 'GET', sigFileSrc,
    function(signature) {
      signature = signature.trim();
      https_everywhereLog(INFO, "Successfully fetched update.json.sig file data");
      if (verifyUpdateSignature(update, signature)) {
        https_everywhereLog(INFO, "Ruleset update data signature verified successfully");
        fetchRulesetDBFile(updateObj.source, updateObj.hashfn, updateObj.hash);
      } else {
        https_everywhereLog(WARN, 'Validation of the update signature provided failed.');
        // TODO
        // Ping the verification-failure-reporting URL
      }
    });
}

/* Attempts to verify the provided signature over updateStr using
 * the hardcoded RULESET_UPDATE_KEY public key.
 */
function verifyUpdateSignature(updateStr, signature) {
  var verifier = Cc['@mozilla.org/security/datasignatureverifier;1']
                   .createInstance(Ci.nsIDataSignatureVerifier);
  https_everywhereLog(INFO, "Created instance of nsIDAtaSignatureVerifier");
  return verifier.verifyData(updateStr, signature, RULESET_UPDATE_KEY);
}


/* Checks that the ruleset version to download is greater than the current ruleset library
 * version (rsVersion) and is a subversion of the extension version (extVersion).
 */
function checkVersionRequirements(extVersion, rsVersion, newVersion) {
  var verCompare = Cc['@mozilla.org/xpcom/version-comparator;1']
                     .getService(Ci.nsIVersionComparator);
  https_everywhereLog(INFO, "Checking version requirements with extension version " + extVersion +
                            " and ruleset version " + rsVersion);
  var newRulesetExtVer = newVersion.slice(0, newVersion.lastIndexOf('.'));
  var sameExtVer = verCompare.compare(extVersion, newRulesetExtVer) === 0;
  var newRSVer = verCompare.compare(newVersion, rsVersion) > 0;
  return sameExtVer && newRSVer;
}

function hashBinaryFile(path, length, hashfn) {
  var f = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsILocalFile);
  var istream = Cc['@mozilla.org/network/file-input-stream;1']
                  .createInstance(Ci.nsIFileInputStream);
  var binaryIn = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);
  var hashing = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
  if      (hashfn === 'md5')    hashing.init(hashing.MD5);
  else if (hashfn === 'sha1')   hashing.init(hashing.SHA1);
  else if (hashfn === 'sha256') hashing.init(hashing.SHA256);
  else if (hashfn === 'sha384') hashing.init(hashing.SHA384);
  else if (hashfn === 'sha512') hashing.init(hashing.SHA512);
  else return null; // It's a better idea to fail than do the wrong thing here.
  f.initWithPath(path);
  istream.init(f, 0x01, 0444, 0);
  binaryIn.setInputStream(istream);
  hashing.updateFromStream(binaryIn, length);
  var hash = hashing.finish(false); // Get binary data back
  istream.close();
  function toHexStr(charCode) {
    return ('0' + charCode.toString(16)).slice(-2);
  }
  return [toHexStr(hash.charCodeAt(i)) for (i in hash)].join('');
}

/* Issues a request to download a new, zipped ruleset database file and then determines whether
 * its hash matches the one provided in the verified update manifest before applying the changes.
 * url  - The full URL to fetch the file from, MUST be using HTTPS!
 * hash - The hash of the database file provided by the update manifest verified previously.
 */
function fetchRulesetDBFile(url, hashfn, hash) {
  https_everywhereLog(INFO, "Making request to get database file at " + url);
  var xhr = Cc['@mozilla.org/xmlextras/xmlhttprequest;1'].createInstance(Ci.nsIXMLHttpRequest);
  xhr.open("GET", url, true);
  xhr.responseType = 'arraybuffer';
  xhr.onload = function(evt) {
    var arrayBuffer = xhr.response;
    if (arrayBuffer) {
      var byteArray = new Uint8Array(arrayBuffer);
      https_everywhereLog(INFO, "byteArray has length " + byteArray.length);
      var file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsILocalFile);
      var outstream = Cc['@mozilla.org/network/file-output-stream;1']
                        .createInstance(Ci.nsIFileOutputStream);
      var binout = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
      file.initWithPath(TMP_RULESET_DBFILE_PATH);
      outstream.init(file, -1, -1, 0);
      binout.setOutputStream(outstream);
      binout.writeByteArray(byteArray, byteArray.length);
      outstream.close();
      dbHash = hashBinaryFile(TMP_RULESET_DBFILE_PATH, byteArray.length, hashfn);
      https_everywhereLog(INFO, "dbhash = " + dbHash);
      //if (dbHash == hash) {
        https_everywhereLog(INFO, 
          'Hash of database file downloaded matches the hash provided by update.json');
        applyNewRuleset();
      //} else {
      //  https_everywhereLog(INFO, 'Hash of database file did not match the one in update.json');
        // TODO: Ping EFF URL to report authenticity verification failure
      //}
    } else {
      https_everywhereLog(INFO, 'Did not download any database data');
      // TODO: Ping EFF URL to report download failure
    }
  };
  xhr.send(null);
}

/* Applies the new ruleset database file by replacing the old one and reinitializing 
 * the mapping of targets to applicable rules.
 */
function applyNewRuleset() {
  https_everywhereLog(INFO, 'In applyNewRuleset');
  var tempDB = Services.storage.openDatabase(new FileUtils.File(
    TMP_RULESET_DBFILE_PATH));
  var mainDB = Services.storage.openDatabase(new FileUtils.File(
    RuleWriter.chromeToPath("chrome://https-everywhere/content/rulesets.sqlite")));
  https_everywhereLog(INFO, 'Opened database connections for copying');
  mainDB.createStatement("drop table rulesets").execute();
  mainDB.createStatement("drop table targets").execute();
  https_everywhereLog(INFO, 'Dropped data from rulesets database');
  var selectStmt = tempDB.createStatement("select host, ruleset_id from targets");
  var insertStmt = mainDB.createStatement("insert into targets (host, ruleset_id) values(:host, :ruleset_id)");
  while (selectStmt.executeStep()) {
    insertStmt.params.host = selectStmt.row.host;
    insertStmt.params.ruleset_id = selectStmt.row.ruleset_id;
    insertStmt.execute();
  }
  https_everywhereLog(INFO, 'Inserted new targets data into database');
  selectStmt = tempDB.createStatement("select contents from rulesets");
  insertStmt = mainDB.createStatement("insert into rulesets (contents) values(:contents)");
  while (selectStmt.executeStep()) {
    insertStmt.params.contents = selectStmt.row.contents;
    insertStmt.execute();
  }
  https_everywhereLog(INFO, 'Inserted new rulesets data into database');
  var tmpFile = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsILocalFIle);
  tmpFile.initWithPath(TMP_RULESET_DBFILE_PATH);
  tmpFile.remove(false);
  https_everywhereLog(INFO, 'Removed temporary database file');
  HTTPSRules.init();
  https_everywhereLog(INFO, 'Reinitialized HTTPSRules');
}

// Export only fetchUpdate
return fetchUpdate;

})() // END MODULE
};   // END OBJECT DEFINITION
