use std::io::{self, BufRead};

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub enum FrameError {
    TooLong,
    Truncated,
    Io(io::Error),
}

/// Reads one LF-delimited frame without buffering more than the configured limit.
pub fn read_frame<R: BufRead>(reader: &mut R) -> Result<Option<Vec<u8>>, FrameError> {
    let mut frame = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(FrameError::Io)?;
        if available.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(FrameError::Truncated)
            };
        }

        let length = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        let has_newline = available[length - 1] == b'\n';
        let content_length = length - usize::from(has_newline);
        let trailing_cr = has_newline
            && (available[..content_length].last() == Some(&b'\r')
                || (content_length == 0 && frame.last() == Some(&b'\r')));
        let prospective_length = frame.len().saturating_add(content_length);
        let payload_length = prospective_length.saturating_sub(usize::from(trailing_cr));
        let pending_cr_is_possible_delimiter = !has_newline
            && prospective_length == MAX_FRAME_BYTES + 1
            && available[..content_length].last() == Some(&b'\r');
        if payload_length > MAX_FRAME_BYTES && !pending_cr_is_possible_delimiter {
            return Err(FrameError::TooLong);
        }
        let append_length = content_length - usize::from(trailing_cr && content_length > 0);
        frame.extend_from_slice(&available[..append_length]);
        reader.consume(length);

        if has_newline {
            if trailing_cr && content_length == 0 {
                frame.pop();
            }
            return Ok(Some(frame));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FrameError, MAX_FRAME_BYTES, read_frame};
    use std::io::{BufReader, Cursor};

    #[test]
    fn accepts_payload_limit_with_crlf_even_when_split_across_buffers() {
        let mut input = vec![b'a'; MAX_FRAME_BYTES];
        input.extend_from_slice(b"\r\n");
        let mut reader = BufReader::with_capacity(31, Cursor::new(input));
        let frame = read_frame(&mut reader).unwrap().unwrap();
        assert_eq!(frame.len(), MAX_FRAME_BYTES);
        assert!(frame.iter().all(|byte| *byte == b'a'));
    }

    #[test]
    fn allows_a_pending_boundary_cr_but_rejects_boundary_content() {
        let mut crlf = vec![b'a'; MAX_FRAME_BYTES];
        crlf.extend_from_slice(b"\r\n");
        let mut reader = BufReader::with_capacity(MAX_FRAME_BYTES + 1, Cursor::new(crlf));
        assert_eq!(
            read_frame(&mut reader).unwrap().unwrap().len(),
            MAX_FRAME_BYTES
        );

        let mut oversized = vec![b'a'; MAX_FRAME_BYTES + 1];
        oversized.extend_from_slice(b"\n");
        assert!(matches!(
            read_frame(&mut BufReader::with_capacity(
                MAX_FRAME_BYTES + 1,
                Cursor::new(oversized)
            )),
            Err(FrameError::TooLong)
        ));
    }

    #[test]
    fn rejects_oversized_and_truncated_frames() {
        let mut oversized = vec![b'a'; MAX_FRAME_BYTES + 1];
        oversized.push(b'\n');
        assert!(matches!(
            read_frame(&mut BufReader::new(Cursor::new(oversized))),
            Err(FrameError::TooLong)
        ));
        assert!(matches!(
            read_frame(&mut BufReader::new(Cursor::new(b"partial"))),
            Err(FrameError::Truncated)
        ));
    }

    #[test]
    fn reads_multiple_frames_and_utf8_split_between_buffers() {
        let mut reader = BufReader::with_capacity(1, Cursor::new("第一\r\n第二\n".as_bytes()));
        assert_eq!(read_frame(&mut reader).unwrap().unwrap(), "第一".as_bytes());
        assert_eq!(read_frame(&mut reader).unwrap().unwrap(), "第二".as_bytes());
        assert!(read_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn preserves_multiple_lines_from_one_buffer() {
        let mut reader = BufReader::with_capacity(32, Cursor::new(b"first\nsecond\n"));
        assert_eq!(read_frame(&mut reader).unwrap().unwrap(), b"first");
        assert_eq!(read_frame(&mut reader).unwrap().unwrap(), b"second");
        assert!(read_frame(&mut reader).unwrap().is_none());
    }
}
