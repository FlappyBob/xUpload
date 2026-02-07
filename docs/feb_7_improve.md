

# 1 Bug + 1 Improve
# Bug: error of uploading file

# Improve: seamless file scanning
- Problem:
  - Have to click scanning every time
  - Not persistent: parsed files disappears very fast
- Scan the whole path:
  - Pro: 
    - have all index to all the files
    - better for long term 
    - Good since we are purely locally
  - Con:
    - slow since all the folders
    - 
- User config: let user config some folders to scan
  - Implementation consideration:
    - When to do rolling scanning: check for file changes
      - Whenever starting chrome
      - If chrome kept open, scan every 30sec/5min/10min, etc
- Track uploading history
  - Let user by default upload with our button so we can track

# Recommandation
- Search with file path (e.g. resume folder is more likely under job website)
- Search with file name (e.g. screen shot with name "2026 Feb 7...png" is more likely to get uploaded to gpt)
- Search with file content (e.g. screen shot with command line error outputs is more likely to get uploaded to gpt for asking error related questions)